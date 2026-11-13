// Drives the real `uh` CLI against one real Ultimate with a temporary HOME and the scripted model.
// Run with Node 26: node scripts/verify-uh.ts
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readLive } from '../src/main/ultimate.ts'
import { cleanEnv, cleanUp, CLONE, makeProject, sleep, startScriptedModel, startUltimate, stillRunning, tempDir, until } from '../test/support/fixtures.ts'
import { createReport } from '../test/support/report.ts'

const UH = join(import.meta.dirname, '../bin/uh.ts')
const { check, results } = createReport()
const section = 'uh'

const home = tempDir('home')
const root = makeProject(tempDir('projects'), 'uh-proof')
const ledger = join(home, '.ultimate-hub/uh/ledger')
const realLedger = existsSync(join(homedir(), '.ultimate-hub/uh'))

type Output = Record<string, any>
const transcript: string[] = []

/** The exact stdout of one `uh` call: one JSON object per line. */
async function uh(args: string[], stdin = ''): Promise<Output> {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', UH, ...args], {
    env: cleanEnv(home),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdin.end(stdin)
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  const [code] = await once(child, 'exit')
  transcript.push(`$ ${stdin ? `printf %s ${JSON.stringify(stdin)} | ` : ''}uh ${args.join(' ')}\n${stdout.trimEnd()}\n(exit ${code})`)
  const output = JSON.parse(stdout)
  assert.equal(code, output.ok ? 0 : 1, 'the exit code matches ok')
  return output
}
const show = (output: Output) => JSON.stringify(output)

try {
  const model = await startScriptedModel(100)
  const turns = (word: string) => model.requests.filter(({ tools, lastRole, lastText }) => tools && lastRole === 'user' && lastText.includes(word)).length
  const ultimate = startUltimate(home, root, model.agentDir)
  const port = await ultimate.port()
  await until('the Ultimate to answer', () => readLive(port, false).catch(() => null), 60000)
  let conversation = 0

  await check(section, 'list gives the running Ultimate', async () => {
    const output = await uh(['list'])
    assert.deepEqual(output, { ok: true, ultimates: [{ root, name: basename(root), port }] })
    return show(output)
  })

  await check(section, 'new makes one conversation for one key', async () => {
    const first = await uh(['new', root, '--key', 'proof-new', '--title', 'uh proof'])
    assert.ok(Number.isSafeInteger(first.conversation))
    assert.deepEqual(await uh(['new', root, '--key', 'proof-new', '--title', 'uh proof']), first)
    conversation = first.conversation
    const { conversations } = await uh(['conversations', root])
    assert.equal(conversations.filter(({ title }: Output) => title === 'uh proof').length, 1)
    return show(first)
  })

  await check(section, 'send submits the prompt once for one key, and read shows working', async () => {
    const first = await uh(['send', root, String(conversation), '--key', 'proof-send'], 'hello timed-3000')
    assert.ok(Number.isSafeInteger(first.submission))
    const reading = await uh(['read', root, String(conversation)])
    assert.equal(reading.state, 'working')
    assert.deepEqual(await uh(['send', root, String(conversation), '--key', 'proof-send'], 'hello timed-3000'), first)
    return `${show(first)} then ${show(reading)}`
  })

  await check(section, 'wait returns idle with the answer, and the model got one turn', async () => {
    const output = await uh(['wait', root, String(conversation), '--timeout', '60'])
    assert.deepEqual(output, { ok: true, state: 'idle', answer: 'Working. Done.' })
    assert.deepEqual(await uh(['read', root, String(conversation)]), output)
    await sleep(1500)
    assert.equal(turns('hello timed-3000'), 1)
    return show(output)
  })

  await check(section, 'status and conversations give the contract shapes', async () => {
    const status = await uh(['status', root])
    assert.deepEqual(Object.keys(status), ['ok', 'busy', 'questions', 'failures'])
    const { conversations } = await uh(['conversations', root])
    assert.deepEqual(conversations.find(({ id }: Output) => id === conversation), { id: conversation, title: 'uh proof', busy: false })
    return `${show(status)} and ${conversations.length} conversations`
  })

  await check(section, 'wait gives working after its timeout', async () => {
    await uh(['send', root, String(conversation), '--key', 'proof-hold'], 'hold-turn')
    const started = performance.now()
    const output = await uh(['wait', root, String(conversation), '--timeout', '2'])
    const took = Math.round(performance.now() - started)
    assert.equal(output.state, 'working')
    assert.ok(took >= 2000 && took < 6000, `returned after ${took} ms`)
    model.release()
    assert.equal((await uh(['wait', root, String(conversation), '--timeout', '60'])).state, 'idle')
    return `${show(output)} after ${took} ms`
  })

  await check(section, 'a failed run gives failed and its error', async () => {
    await uh(['send', root, String(conversation), '--key', 'proof-fail'], 'fail-turn')
    const output = await uh(['wait', root, String(conversation), '--timeout', '60'])
    assert.equal(output.state, 'failed')
    assert.match(output.answer, /scripted failure/)
    return show(output)
  })

  await check(section, 'a question to the user gives question, and a reply ends it', async () => {
    // Only @ultimate and branches can ask the user. A page opens @ultimate with this action.
    const origin = `http://127.0.0.1:${port}`
    const opened = await fetch(`${origin}/api/extensions/subagents/actions/standing`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ args: { name: 'ultimate' } }) })
    const primary = String((await opened.json()).result)
    await uh(['send', root, primary, '--key', 'proof-ask'], 'ask-owner')
    const output = await uh(['wait', root, primary, '--timeout', '60'])
    assert.deepEqual(output, { ok: true, state: 'question', answer: 'Ship it?' })
    const status = await uh(['status', root])
    assert.equal(status.questions, 1)
    await uh(['send', root, primary, '--key', 'proof-reply'], 'Yes.')
    const replied = await uh(['wait', root, primary, '--timeout', '60'])
    assert.deepEqual(replied, { ok: true, state: 'idle', answer: 'Done.' })
    return `${show(output)} then ${show(replied)}`
  })

  await check(section, 'a run with a tool step never shows as stopped between its steps', async () => {
    const { conversation: stepped } = await uh(['new', root, '--key', 'proof-steps'])
    await uh(['send', root, String(stepped), '--key', 'proof-steps-send'], 'ask-owner')
    const samples: boolean[] = []
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      samples.push((await readLive(port, false)).conversations.find(({ id }) => id === stepped)!.busy)
      await sleep(10)
    }
    const stopped = samples.indexOf(false, samples.indexOf(true))
    assert.ok(samples.includes(true) && stopped !== -1, 'the run was seen, and its end')
    assert.ok(!samples.slice(stopped).includes(true), 'no busy sample after the first stopped sample')
    return `${samples.length} samples in 5 s: ${samples.indexOf(true)} before the run, ${stopped - samples.indexOf(true)} busy, ${samples.length - stopped} stopped`
  })

  await check(section, 'the errors have their codes', async () => {
    const codes = {
      not_found: (await uh(['read', root, '999999'])).error.code,
      'not_found on send': (await uh(['send', root, '999999', '--key', 'proof-missing'], 'hello')).error.code,
      not_running: (await uh(['status', join(root, 'none')])).error.code,
      usage: (await uh(['send', root, String(conversation)], 'hello')).error.code,
    }
    assert.deepEqual(codes, { not_found: 'not_found', 'not_found on send': 'not_found', not_running: 'not_running', usage: 'usage' })
    return show(codes)
  })

  await check(section, 'the ledger is in the temporary HOME, and the real HOME gets none', () => {
    const files = execFileSync('/bin/ls', [ledger], { encoding: 'utf8' }).trim().split('\n')
    assert.equal(files.length, 8)
    assert.equal(existsSync(join(homedir(), '.ultimate-hub/uh')), realLedger)
    return `${files.length} keys in ${ledger}`
  })

  await ultimate.stop()
  await check(section, 'list is empty after the Ultimate stops', async () => {
    const output = await uh(['list'])
    assert.deepEqual(output, { ok: true, ultimates: [] })
    assert.equal((await uh(['status', root])).error.code, 'not_running')
    return show(output)
  })
  model.close()
} finally {
  await check('safety', 'the Ultimate clone stays unmodified', () => {
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: CLONE, encoding: 'utf8' }).trim(), '')
    return 'git status --porcelain is empty'
  })
  await cleanUp()
  await check('cleanup', 'no process of this run remains', () => {
    assert.equal(stillRunning().length, 0)
    return 'every started process exited'
  })
}

console.log(`\n--- transcript ---\n${transcript.join('\n\n')}`)
const failures = results.filter(({ status }) => status === 'fail').length
console.log(`\n${results.length - failures} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
