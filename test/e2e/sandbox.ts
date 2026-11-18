import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, processTree, startStub, tempDir, until, writeLock } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import type { Check } from '../support/report.ts'
import { chooseAddUltimate, planPicker } from './add.ts'
import { chooseClose, fakeClone, lifeOf, savedLifecycle, sheetsAfter, waitForLife } from './lifecycle.ts'

const section = 'sandbox'
const LAUNCHER = join(import.meta.dirname, '../support/sandbox-launcher.ts')
const NODE = realpathSync(process.execPath)
const SANDBOX_PAUSE_WARNING = "This stops the sandbox and interrupts active work. Start runs the sandbox's restart command again."
const NO_RESTART = 'This sandbox gives Hub no command to start it again, so Hub can close it but not pause it.'
const NO_LAUNCHER = 'Hub starts Ultimate the way a running or paused one was started. Start one Ultimate from a terminal, then try again.'

type SandboxLock = { pid: number; port: number; restart?: string[] }

/** Hub against sandbox launchers that meet docs/sandbox.md, with a stub server in place of each sandbox. */
export async function runSandboxChecks(check: Check) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const root = (name: string) => join(projects, name)
  const lockOf = (name: string): SandboxLock | null => {
    try {
      return JSON.parse(readFileSync(join(home, '.ultimate', 'projects', `${name}.sandbox.lock`), 'utf8'))
    } catch {
      return null
    }
  }
  const launch = async (project: string, mode: 'restart' | 'no-restart', name = project) => {
    mkdirSync(root(project), { recursive: true })
    spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', LAUNCHER, home, root(project), mode, name], { stdio: 'ignore', detached: true }).unref()
    return until(`the ${name} sandbox lock`, () => lockOf(name), 10000)
  }
  const lockNames = ['boxed', 'sealed', 'twin-old', 'twin-new', 'mixed', 'quiet']
  const signals = async () => (await hub.processCalls()).signals
  const sheetCount = async () => (await hub.sheetsShown()).length
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  let hub = await Hub.launch(home, userData, env)
  try {
    await hub.spyOnProcesses()
    await hub.planSheets([])
    const first = await launch('boxed', 'restart')
    // The sandbox shares its project folder, so its project also has the lock of the Ultimate inside, with a pid from there.
    writeLock(home, root('boxed'), { pid: 1, port: first.port })

    await check(section, 'a sandbox shows in its own tab, on the port of its lock, beside a guest ultimate.lock that fails the local proof', async () => {
      await until('the boxed row', async () => (await hub.tab('boxed'))?.port === first.port, 15000)
      assert.equal((await lifeOf(hub, 'boxed'))?.name, 'Pause boxed')
      return `boxed is on port ${first.port}. The launcher is pid ${first.pid}, a separate stub holds the port, and ultimate.lock names pid 1.`
    })

    await check(section, '+ > Ultimate refuses when every running or paused launcher is a sandbox, and runs no restart command', async () => {
      const shown = await sheetCount()
      mkdirSync(root('fresh'), { recursive: true })
      await planPicker(hub, root('fresh'))
      await hub.planSheets(['action'])
      await chooseAddUltimate(hub)
      const sheet = (await sheetsAfter(hub, shown)).at(-1)!
      assert.deepEqual([sheet.title, sheet.text], ['Hub could not find Ultimate on this Mac', NO_LAUNCHER])
      assert.deepEqual((await hub.processCalls()).spawns, [])
      return `"${sheet.title}" with no spawn, while sandbox boxed runs with a restart command.`
    })

    await check(section, 'Pause asks with the sandbox wording, sends one SIGTERM to the launcher, saves its restart command, and Play runs it', async () => {
      const shown = await sheetCount()
      await hub.planSheets(['action'])
      await hub.topRow('boxed').locator('.life').click()
      await waitForLife(hub, 'boxed', 'Start boxed', 20000)
      const question = (await hub.sheetsShown())[shown]
      assert.deepEqual([question.title, question.text], ['Pause boxed?', SANDBOX_PAUSE_WARNING])
      assert.deepEqual(await signals(), [{ pid: first.pid, signal: 'SIGTERM' }])
      assert.ok(!isAlive(first.pid), 'the launcher exited')
      assert.deepEqual(savedLifecycle(hub, root('boxed')), { kind: 'paused', launcher: { command: first.restart } })
      await hub.topRow('boxed').locator('.life').click()
      await waitForLife(hub, 'boxed', 'Pause boxed', 30000)
      const again = lockOf('boxed')!
      assert.notEqual(again.pid, first.pid)
      assert.equal((await hub.tab('boxed'))?.port, again.port)
      const spawned = (await hub.processCalls()).spawns.filter(({ file }) => file === first.restart![0])
      assert.deepEqual(spawned.map(({ args }) => args), [first.restart!.slice(1)])
      return `"${question.text}" One SIGTERM to launcher ${first.pid}. tabs.json held its restart command. Play ran it once, and the new launcher ${again.pid} shows on port ${again.port}.`
    })

    await check(section, 'a sandbox with no restart command refuses Pause before any question, and Close stops it', async () => {
      const sealed = await launch('sealed', 'no-restart')
      await until('the sealed row', async () => (await hub.tab('sealed'))?.port === sealed.port, 15000)
      const shown = await sheetCount()
      const before = (await signals()).length
      await hub.planSheets(['action'])
      await hub.topRow('sealed').locator('.life').click()
      const refusal = (await sheetsAfter(hub, shown)).at(-1)!
      assert.equal(refusal.text, NO_RESTART)
      assert.equal((await signals()).length, before)
      await hub.planSheets(['action'])
      await chooseClose(hub, 'sealed')
      await until('the sealed row to leave', async () => !(await hub.tab('sealed')), 20000)
      assert.deepEqual((await signals()).slice(before), [{ pid: sealed.pid, signal: 'SIGTERM' }])
      assert.ok(!isAlive(sealed.pid), 'the launcher exited')
      return `Pause refused with "${refusal.text}" and no signal. Close sent one SIGTERM to launcher ${sealed.pid}, and the row left.`
    })

    await check(section, 'a sandbox leaves the list when its Ultimate stops answering, even while its launcher runs', async () => {
      const quiet = await launch('quiet', 'restart')
      await until('the quiet row', async () => (await hub.tab('quiet'))?.port === quiet.port, 15000)
      // A stopped stub keeps its socket, so the port takes connections and nothing answers, as in a hung sandbox.
      const [stub] = processTree(quiet.pid).filter((pid) => pid !== quiet.pid)
      process.kill(stub, 'SIGSTOP')
      await until('the quiet row to leave', async () => !(await hub.tab('quiet')), 20000)
      assert.ok(isAlive(quiet.pid), 'the launcher still runs')
      process.kill(stub, 'SIGKILL')
      return `after the stub ${stub} stopped answering, the row left while launcher ${quiet.pid} still ran.`
    })

    await check(section, 'with two live locks for one project, the tab shows the newer launch, and Close signals only that launcher', async () => {
      const older = await launch('twin', 'no-restart', 'twin-old')
      // lstart has a resolution of one second, so the newer launch starts in a later second.
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const newer = await launch('twin', 'no-restart', 'twin-new')
      await until('the twin row on the newer port', async () => (await hub.tab('twin'))?.port === newer.port, 15000)
      const before = (await signals()).length
      await hub.planSheets(['action'])
      await chooseClose(hub, 'twin')
      await until('the newer launcher to exit', () => !isAlive(newer.pid), 20000)
      assert.deepEqual((await signals()).slice(before), [{ pid: newer.pid, signal: 'SIGTERM' }])
      assert.ok(isAlive(older.pid), 'the older launcher is not signalled')
      return `the row showed port ${newer.port} of launcher ${newer.pid}. Close sent one SIGTERM to it, and the older launcher ${older.pid} still runs.`
    })

    await check(section, 'when the check of a local Ultimate cannot run, Pause refuses, and the sandbox of the same project gets no signal', async () => {
      const local = await startStub(home, root('mixed'))
      const sandbox = await launch('mixed', 'restart')
      await until('the mixed row on the local port', async () => (await hub.tab('mixed'))?.port === local.port, 15000)
      const shown = await sheetCount()
      const before = (await signals()).length
      await hub.injectLsof({ count: 2 })
      await hub.planSheets(['action'])
      await hub.topRow('mixed').locator('.life').click()
      const refusal = (await sheetsAfter(hub, shown)).at(-1)!
      assert.equal(refusal.text, 'Hub could not check the process (lsof failed).')
      await until('the injection to be used up', async () => (await hub.lsofFailuresSeen()) >= 2, 10000)
      assert.equal((await signals()).length, before)
      assert.equal(savedLifecycle(hub, root('mixed')), null)
      assert.ok(isAlive(local.child.pid!) && isAlive(sandbox.pid))
      await local.stop()
      return `the local stub won the tab. With lsof failing, Pause refused with "${refusal.text}", sent no signal to the sandbox launcher ${sandbox.pid}, and saved no record.`
    })

    await check(section, '+ > Ultimate starts a new project with a local launcher, never with the restart command of a running sandbox', async () => {
      const entry = fakeClone(tempDir('clone'), 'ultimate', `process.stderr.write('fake clone\\n')\nprocess.exit(1)\n`)
      await hub.quit()
      const saved = JSON.parse(readFileSync(join(userData, 'tabs.json'), 'utf8'))
      mkdirSync(root('parked'), { recursive: true })
      saved.tabs.push({ root: root('parked'), name: null, groupId: null, lifecycle: { kind: 'paused', launcher: { node: NODE, entry } } })
      writeFileSync(join(userData, 'tabs.json'), JSON.stringify(saved))
      hub = await Hub.launch(home, userData, env)
      await hub.spyOnProcesses()
      await hub.planSheets([])
      await until('the boxed row', async () => (await hub.tab('boxed'))?.port === lockOf('boxed')!.port, 15000)
      mkdirSync(root('fresher'), { recursive: true })
      await planPicker(hub, root('fresher'))
      await hub.planSheets(['action', 'action'])
      await chooseAddUltimate(hub)
      const spawn = await until('the start', async () => (await hub.processCalls()).spawns[0], 10000)
      assert.deepEqual({ file: spawn.file, args: spawn.args }, { file: NODE, args: [entry, root('fresher'), '--no-open'] })
      return `the new project started with ${NODE} ${entry} from the paused local tab, while sandbox boxed ran with restart ${JSON.stringify(lockOf('boxed')!.restart)}.`
    })
  } finally {
    await hub.quit()
    for (const name of lockNames) {
      const lock = lockOf(name)
      if (lock && isAlive(lock.pid)) {
        process.kill(lock.pid, 'SIGTERM')
        await until(`the ${name} launcher to exit`, () => !isAlive(lock.pid), 10000)
      }
    }
  }
}
