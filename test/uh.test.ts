import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { turnOf } from '../src/cli/uh.ts'
import { startOf, writeLock, writeSandboxLock } from './support/fixtures.ts'

const UH = join(import.meta.dirname, '../bin/uh.ts')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'uh-test-home-')))
const ROOT = '/projects/alpha'
const DEAD_ROOT = '/projects/dead'

type Entry = { kind: string; model?: object[] }
const said = (text: string): Entry => ({ kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }] })
const failed = (errorMessage: string): Entry => ({ kind: 'pi.assistant', model: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage }] })
const toolCall: Entry = { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' }] }
const asked: Entry = { kind: 'pi.user', model: [{ role: 'user', content: 'hello' }] }

/** What the fake Ultimate holds. Each test starts from `fresh()`. */
type State = {
  summaries: { id: number; title?: string; busy: boolean; inputAt?: number }[]
  tasks: Record<string, { conversationId: number; background: boolean }>
  board: object[]
  history: Record<number, Entry[]>
  status: string
  created: (string | undefined)[]
  submitted: { conversation: number; text: string }[]
  dropNextWrite: boolean
  legacyEvents: boolean
}
const fresh = (): State => ({
  summaries: [{ id: 1, busy: false }, { id: 5, title: 'Fix the build', busy: false, inputAt: 1000 }],
  tasks: {},
  board: [],
  history: { 1: [], 5: [said('Done.'), asked] },
  status: JSON.stringify({ result: { busy: 2, questions: { count: 1 }, failures: [{}, {}, {}] } }),
  created: [],
  submitted: [],
  dropNextWrite: false,
  legacyEvents: false,
})
let state = fresh()
beforeEach(() => {
  state = fresh()
  rmSync(join(home, '.ultimate-hub'), { recursive: true, force: true })
})

const streams = new Map<string, ServerResponse>()
const json = (response: ServerResponse, status: number, data: unknown) => response.writeHead(status).end(JSON.stringify(data))

async function handle(request: IncomingMessage, response: ServerResponse) {
  let body = ''
  for await (const chunk of request) body += chunk
  const data = body ? JSON.parse(body) : {}
  const url = new URL(request.url!, 'http://fake')
  const conversation = /^\/api\/conversations\/(\d+)\/(history|submit)$/.exec(url.pathname)
  const subscription = (state.legacyEvents ? /^\/api\/events\/(\w+)\/(\d+)$/ : /^\/api\/events\/(\w+)$/).exec(url.pathname)
  if (url.pathname === '/api/events') {
    const id = `s${streams.size}`
    streams.set(id, response)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`retry: 500\n\nevent: stream\ndata: ${JSON.stringify({ id })}\n\n`)
    response.write(`event: conversations\ndata: ${JSON.stringify(state.summaries)}\n\n`)
    response.write(`event: tasks\ndata: ${JSON.stringify({ tasks: state.tasks })}\n\n`)
  } else if (subscription) {
    const spec = state.legacyEvents ? { sub: Number(subscription[2]), ...data } : data.subscribe[0]
    assert.deepEqual(spec, { sub: 1, docs: ['board'], view: false })
    if (!state.legacyEvents) assert.deepEqual(data.unsubscribe, [])
    streams.get(subscription[1])!.write(`event: doc\ndata: ${spec.sub}\ndata: ${JSON.stringify({ kind: 'board', value: { messages: state.board } })}\n\n`)
    json(response, 200, { ok: true, refused: {} })
  } else if (url.pathname === '/api/extensions/status/actions/status') {
    if (request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: 'Forbidden' })
    response.end(state.status)
  } else if (conversation && !state.history[Number(conversation[1])]) {
    json(response, 404, { error: 'Unknown conversation' })
  } else if (conversation?.[2] === 'history') {
    const entries = state.history[Number(conversation[1])]
    const from = url.searchParams.get('before') === String(Number.MAX_SAFE_INTEGER) ? 0 : Number(url.searchParams.get('before'))
    json(response, 200, { entries: entries.slice(from, from + 2), before: from + 2 < entries.length ? from + 2 : undefined })
  } else if (url.pathname === '/api/conversations' || conversation) {
    if (conversation) state.submitted.push({ conversation: Number(conversation[1]), text: data.text })
    else state.created.push(data.title)
    if (state.dropNextWrite) {
      state.dropNextWrite = false
      return void response.destroy()
    }
    if (conversation) json(response, 202, { submissionId: 70 + state.submitted.length })
    else json(response, 201, { id: 40 + state.created.length })
  } else json(response, 404, { error: 'Unknown endpoint' })
}

const server = createServer(handle)
const dead = createSocketServer((socket) => socket.destroy())
server.listen(0, '127.0.0.1')
dead.listen(0, '127.0.0.1')
await Promise.all([once(server, 'listening'), once(dead, 'listening')])
const { port } = server.address() as AddressInfo
writeLock(home, ROOT, { pid: process.pid, port })
writeLock(home, DEAD_ROOT, { pid: process.pid, port: (dead.address() as AddressInfo).port })

// Sandboxes: each launcher is one process, and its port belongs to another, as a sandbox's port forwarder would hold it.
const listen = async () => {
  const sandboxServer = createServer(handle)
  sandboxServer.listen(0, '127.0.0.1')
  await once(sandboxServer, 'listening')
  return sandboxServer
}
const sleeper = async () => {
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' })
  await once(child, 'spawn')
  return child
}
// The elder starts first, so the launcher is the newer launch: a later start, or the same second and a higher pid.
const elder = await sleeper()
const launcher = await sleeper()
const gone = await sleeper()
const goneStart = startOf(gone.pid!)
gone.kill()
await once(gone, 'exit')
const [boxed, nulled] = await Promise.all([listen(), listen()])
const boxedPort = (boxed.address() as AddressInfo).port
const nulledPort = (nulled.address() as AddressInfo).port
/** A sandbox's project is a real folder, because Hub keys it by its real path. */
const folder = (name: string) => {
  mkdirSync(join(home, 'projects', name), { recursive: true })
  return join(home, 'projects', name)
}
const BOXED_ROOT = folder('boxed')
const NULLED_ROOT = folder('nulled')
const sandbox = { pid: launcher.pid!, start: startOf(launcher.pid!), port: boxedPort }
writeSandboxLock(home, 'boxed', { ...sandbox, project: BOXED_ROOT })
writeSandboxLock(home, 'boxed-crashed', { pid: gone.pid!, start: goneStart, port: nulledPort, project: BOXED_ROOT })
writeSandboxLock(home, 'nulled', { ...sandbox, port: nulledPort, project: NULLED_ROOT, restart: null })
writeSandboxLock(home, 'same-port', { pid: elder.pid!, start: startOf(elder.pid!), port: boxedPort, project: folder('same-port') })
writeSandboxLock(home, 'reused-pid', { ...sandbox, start: 'Thu Jan  1 00:00:00 1970', project: folder('reused-pid') })
writeSandboxLock(home, 'local-port', { ...sandbox, port, project: folder('local-port') })
writeSandboxLock(home, 'silent', { ...sandbox, port: (dead.address() as AddressInfo).port, project: folder('silent') })
writeSandboxLock(home, 'no-folder', { ...sandbox, port: nulledPort, project: join(home, 'projects', 'missing') })
after(() => {
  server.closeAllConnections()
  server.close()
  dead.close()
  for (const sandboxServer of [boxed, nulled]) {
    sandboxServer.closeAllConnections()
    sandboxServer.close()
  }
  elder.kill()
  launcher.kill()
  rmSync(home, { recursive: true, force: true })
})

/** Runs the real CLI as its caller does, and holds it to one JSON object on stdout and an exit code that matches `ok`. */
async function uh(args: string[], stdin = ''): Promise<Record<string, any>> {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', UH, ...args], {
    env: { HOME: home, PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdin.end(stdin)
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  const [code] = await once(child, 'exit')
  assert.match(stdout, /^\{.*\}\n$/, 'stdout is one JSON line')
  const output = JSON.parse(stdout)
  assert.equal(code, output.ok ? 0 : 1)
  return output
}
const codeOf = async (args: string[], stdin?: string) => (await uh(args, stdin)).error?.code

test('list gives each running Ultimate with its root, name, and port', async () => {
  const output = await uh(['list'])
  assert.deepEqual(output.ultimates.find(({ root }: { root: string }) => root === ROOT), { root: ROOT, name: 'alpha', port })
  assert.equal(output.ok, true)
})

test('list gives a sandbox whose launcher runs with its start time and where an Ultimate answers, with or without restart', async () => {
  const { ultimates } = await uh(['list'])
  const rowOf = (root: string) => ultimates.find((row: { root: string }) => row.root === root)
  assert.deepEqual(rowOf(BOXED_ROOT), { root: BOXED_ROOT, name: 'boxed', port: boxedPort }, 'the lock of a crashed launcher does not hide the live one')
  assert.deepEqual(rowOf(NULLED_ROOT), { root: NULLED_ROOT, name: 'nulled', port: nulledPort }, 'a null restart still shows')
  for (const name of ['reused-pid', 'local-port', 'silent', 'missing']) assert.equal(rowOf(join(home, 'projects', name)), undefined, name)
  assert.deepEqual(await uh(['status', BOXED_ROOT]), { ok: true, busy: 2, questions: 1, failures: 3 })
})

test('one port gives one row: a local Ultimate wins it, then the newest sandbox launch', async () => {
  const { ultimates } = await uh(['list'])
  const ports = ultimates.map((row: { port: number }) => row.port)
  assert.equal(ports.filter((at: number) => at === boxedPort).length, 1)
  assert.equal(ports.filter((at: number) => at === port).length, 1)
  assert.equal(ultimates.find((row: { root: string }) => row.root === join(home, 'projects', 'same-port')), undefined)
})

test('status gives the three counts', async () => {
  assert.deepEqual(await uh(['status', ROOT]), { ok: true, busy: 2, questions: 1, failures: 3 })
})

test('conversations gives id, title, and busy from the task graph', async () => {
  state.tasks = { 9: { conversationId: 5, background: false }, 10: { conversationId: 1, background: true } }
  assert.deepEqual(await uh(['conversations', ROOT]), {
    ok: true,
    conversations: [{ id: 1, title: null, busy: false }, { id: 5, title: 'Fix the build', busy: true }],
  })
})

test('new makes one conversation for one key', async () => {
  const first = await uh(['new', ROOT, '--key', 'k1', '--title', 'Plan'])
  assert.deepEqual(first, { ok: true, conversation: 41 })
  assert.deepEqual(await uh(['new', ROOT, '--key', 'k1', '--title', 'Plan']), first)
  assert.deepEqual(state.created, ['Plan'])
  assert.deepEqual(await uh(['new', ROOT, '--key', 'k2']), { ok: true, conversation: 42 })
})

test('send submits the stdin text once for one key', async () => {
  const first = await uh(['send', ROOT, '5', '--key', 'k1'], 'Fix it.\n--key is text here')
  assert.deepEqual(first, { ok: true, submission: 71 })
  assert.deepEqual(await uh(['send', ROOT, '5', '--key', 'k1'], 'Fix it.\n--key is text here'), first)
  assert.deepEqual(state.submitted, [{ conversation: 5, text: 'Fix it.\n--key is text here' }])
})

test('a key of one call is refused for a different call', async () => {
  await uh(['new', ROOT, '--key', 'k1'])
  assert.equal(await codeOf(['send', ROOT, '5', '--key', 'k1'], 'hello'), 'usage')
  assert.deepEqual(state.submitted, [])
})

test('a write whose answer is lost is never sent again', async () => {
  state.dropNextWrite = true
  assert.equal(await codeOf(['send', ROOT, '5', '--key', 'k1'], 'hello'), 'unknown_outcome')
  assert.equal(await codeOf(['send', ROOT, '5', '--key', 'k1'], 'hello'), 'unknown_outcome')
  assert.equal(state.submitted.length, 1)
  state.dropNextWrite = true
  assert.equal(await codeOf(['new', ROOT, '--key', 'k2']), 'unknown_outcome')
  assert.equal(await codeOf(['new', ROOT, '--key', 'k2']), 'unknown_outcome')
  assert.equal(state.created.length, 1)
})

test('a write that Ultimate refused leaves the key free', async () => {
  assert.equal(await codeOf(['send', ROOT, '999', '--key', 'k1'], 'hello'), 'not_found')
  assert.deepEqual(await uh(['send', ROOT, '5', '--key', 'k1'], 'hello'), { ok: true, submission: 71 })
})

test('the ledger does not hold the prompt text', async () => {
  await uh(['send', ROOT, '5', '--key', 'k1'], 'a private prompt')
  const folder = join(home, '.ultimate-hub/uh/ledger')
  const [file] = readdirSync(folder)
  assert.deepEqual(JSON.parse(readFileSync(join(folder, file), 'utf8')), { call: JSON.stringify(['send', ROOT, 5]), result: 71 })
})

test('read gives idle and the newest assistant text', async () => {
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'idle', answer: 'Done.' })
})

test('read gives a null answer for a conversation with no assistant message', async () => {
  assert.deepEqual(await uh(['read', ROOT, '1']), { ok: true, state: 'idle', answer: null })
})

test('read finds the answer on a later page of history', async () => {
  state.history[5] = [toolCall, asked, toolCall, toolCall, said('An old answer.'), said('An older answer.')]
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'idle', answer: 'An old answer.' })
})

test('read gives working while a task of the conversation runs', async () => {
  state.tasks = { 9: { conversationId: 5, background: false } }
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'working', answer: 'Done.' })
})

test('read gives question and the text of the open question', async () => {
  state.board = [
    { from: 5, to: 'user', reply: true, state: 'answered', at: 2000, text: 'An answered question?' },
    { from: 5, to: 'user', reply: true, state: 'delivered', at: 3000, text: 'Ship it?' },
    { from: 1, to: 'user', reply: true, state: 'delivered', at: 4000, text: 'A question of another conversation?' },
  ]
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'question', answer: 'Ship it?' })
})

test('read supports Ultimate before batched subscriptions', async () => {
  state.legacyEvents = true
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'idle', answer: 'Done.' })
})

test('read gives failed and the error of the run', async () => {
  state.history[5] = [failed('429 rate limited'), asked, said('Done.')]
  assert.deepEqual(await uh(['read', ROOT, '5']), { ok: true, state: 'failed', answer: '429 rate limited' })
})

test('wait returns the current state after the timeout', async () => {
  state.tasks = { 9: { conversationId: 5, background: false } }
  const started = performance.now()
  assert.deepEqual(await uh(['wait', ROOT, '5', '--timeout', '1']), { ok: true, state: 'working', answer: 'Done.' })
  const took = performance.now() - started
  assert.ok(took >= 1000 && took < 4000, `returned after ${Math.round(took)} ms`)
})

test('wait returns when the conversation stops working', async () => {
  state.tasks = { 9: { conversationId: 5, background: false } }
  setTimeout(() => {
    state.tasks = {}
    state.history[5] = [said('The new answer.'), asked, ...state.history[5]]
  }, 1200)
  assert.deepEqual(await uh(['wait', ROOT, '5', '--timeout', '30']), { ok: true, state: 'idle', answer: 'The new answer.' })
})

test('each error has its code', async () => {
  assert.equal(await codeOf(['status', '/projects/none']), 'not_running')
  assert.equal(await codeOf(['read', ROOT, '999']), 'not_found')
  assert.equal(await codeOf(['wait', ROOT, '999', '--timeout', '0']), 'not_found')
  assert.equal(await codeOf(['status', DEAD_ROOT]), 'unreachable')
  assert.equal(await codeOf(['conversations', DEAD_ROOT]), 'unreachable')
  assert.equal(await codeOf(['read', DEAD_ROOT, '5']), 'unreachable')
  state.status = JSON.stringify({ result: { busy: 'many' } })
  assert.equal(await codeOf(['status', ROOT]), 'protocol')
  state.summaries = [{ id: 5, title: 7 as unknown as string, busy: false }]
  assert.equal(await codeOf(['conversations', ROOT]), 'protocol')
})

test('wrong arguments give usage, and nothing reaches Ultimate', async () => {
  for (const args of [
    [],
    ['start', ROOT],
    ['list', ROOT],
    ['status'],
    ['status', 'alpha'],
    ['status', ROOT, '--key', 'k'],
    ['read', ROOT],
    ['read', ROOT, 'five'],
    ['read', ROOT, '0'],
    ['read', ROOT, '5', '6'],
    ['new', ROOT],
    ['new', ROOT, '--key', 'k', '--port', '1'],
    ['send', ROOT, '5'],
    ['send', ROOT, '5', '--key', 'k', 'a prompt as an argument'],
    ['wait', ROOT, '5', '--timeout', 'soon'],
    ['wait', ROOT, '5', '--timeout', '-1'],
  ])
    assert.equal(await codeOf(args, 'hello'), 'usage', args.join(' '))
  assert.equal(await codeOf(['send', ROOT, '5', '--key', 'k'], '  \n'), 'usage')
  assert.deepEqual([state.created, state.submitted], [[], []])
})

test('the state rule: working, then a question newer than the input, then failed, then idle', () => {
  const idle = { id: 5, title: null, busy: false, inputAt: 1000 }
  const question = { conversation: 5, at: 2000, text: 'Ship it?' }
  const messages = [{ text: null, error: 'boom' }, { text: 'Before.', error: null }]
  assert.deepEqual(turnOf({ ...idle, busy: true }, [question], messages), { state: 'working', answer: 'Before.' })
  assert.deepEqual(turnOf(idle, [question], messages), { state: 'question', answer: 'Ship it?' })
  assert.deepEqual(turnOf({ ...idle, inputAt: 3000 }, [question], messages), { state: 'failed', answer: 'boom' })
  assert.deepEqual(turnOf(idle, [], [{ text: 'Partial.', error: 'boom' }]), { state: 'failed', answer: 'Partial.' })
  assert.deepEqual(turnOf({ ...idle, inputAt: 3000 }, [question], messages.slice(1)), { state: 'idle', answer: 'Before.' })
  assert.deepEqual(turnOf({ ...idle, inputAt: null }, [], []), { state: 'idle', answer: null })
})
