import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, tempDir, until } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import type { Check } from '../support/report.ts'
import { chooseClose, lifeOf, savedLifecycle, sheetsAfter, waitForLife } from './lifecycle.ts'

const section = 'sandbox'
const LAUNCHER = join(import.meta.dirname, '../support/sandbox-launcher.ts')

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
  const launch = (name: string, mode: 'restart' | 'no-restart') => {
    mkdirSync(root(name), { recursive: true })
    spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', LAUNCHER, home, root(name), mode], { stdio: 'ignore', detached: true }).unref()
    return until(`the ${name} sandbox lock`, () => lockOf(name), 10000)
  }
  const signals = async () => (await hub.processCalls()).signals
  const hub = await Hub.launch(home, userData)
  try {
    await hub.spyOnProcesses()
    const first = await launch('boxed', 'restart')

    await check(section, 'a sandbox shows in its own tab, on the port of its lock, while its launcher runs', async () => {
      await until('the boxed row', async () => (await hub.tab('boxed'))?.port === first.port, 15000)
      assert.equal((await lifeOf(hub, 'boxed'))?.name, 'Pause boxed')
      return `boxed is on port ${first.port}. The launcher is pid ${first.pid}, and a separate stub process holds the port.`
    })

    await check(section, 'Pause sends one SIGTERM to the launcher, saves its restart command, and Play starts the sandbox again with it', async () => {
      await hub.planSheets(['action'])
      await hub.topRow('boxed').locator('.life').click()
      await waitForLife(hub, 'boxed', 'Start boxed', 20000)
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
      return `one SIGTERM to launcher ${first.pid}. tabs.json held its restart command. Play ran it once, and the new launcher ${again.pid} shows on port ${again.port}.`
    })

    await check(section, 'a sandbox with no restart command refuses Pause before any question, and Close stops it', async () => {
      const sealed = await launch('sealed', 'no-restart')
      await until('the sealed row', async () => (await hub.tab('sealed'))?.port === sealed.port, 15000)
      const shown = (await hub.sheetsShown()).length
      const before = (await signals()).length
      await hub.planSheets(['action'])
      await hub.topRow('sealed').locator('.life').click()
      const refusal = (await sheetsAfter(hub, shown)).at(-1)!
      assert.equal(refusal.text, 'This sandbox gives Hub no command to start it again, so Hub can close it but not pause it.')
      assert.equal((await signals()).length, before)
      await hub.planSheets(['action'])
      await chooseClose(hub, 'sealed')
      await until('the sealed row to leave', async () => !(await hub.tab('sealed')), 20000)
      assert.deepEqual((await signals()).slice(before), [{ pid: sealed.pid, signal: 'SIGTERM' }])
      assert.ok(!isAlive(sealed.pid), 'the launcher exited')
      return `Pause refused with "${refusal.text}" and no signal. Close sent one SIGTERM to launcher ${sealed.pid}, and the row left.`
    })
  } finally {
    await hub.quit()
    for (const name of ['boxed', 'sealed']) {
      const lock = lockOf(name)
      if (lock && isAlive(lock.pid)) {
        process.kill(lock.pid, 'SIGTERM')
        await until(`the ${name} launcher to exit`, () => !isAlive(lock.pid), 10000)
      }
    }
  }
}
