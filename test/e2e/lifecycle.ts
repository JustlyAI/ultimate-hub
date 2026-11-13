import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INSTANCE_CHANGED } from '../../src/shared/tabs.ts'
import {
  CLONE,
  isAlive,
  listeningPorts,
  makeProject,
  processTree,
  projectHome,
  sleep,
  startScriptedModel,
  startStub,
  startUltimate,
  tempDir,
  until,
  writeLock,
  type Stub,
} from '../support/fixtures.ts'
import { APP, Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { settled, showProject } from './real.ts'

const section = 'lifecycle'
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const NODE = realpathSync(process.execPath)
const ENTRY = realpathSync(join(CLONE, 'bin/ultimate.ts'))
const PAUSE_WARNING = 'This stops the server and interrupts active work. When it starts again, Ultimate continues interrupted work from its last checkpoint.'
const CLOSE_WARNING = 'This stops the server and removes it from Hub. Active work can be interrupted. Project files and saved conversations are not deleted.'
const holdTurns = (requests: { lastText: string; tools: boolean }[]) => requests.filter(({ lastText, tools }) => tools && lastText.includes('hold-turn')).length

type Lock = { pid: number; port: number; project: string }
type Life = { name: string; kind: string; disabled: boolean } | null

const lockOf = (home: string, root: string): Lock | null => {
  try {
    return JSON.parse(readFileSync(join(projectHome(home, root), 'ultimate.lock'), 'utf8'))
  } catch {
    return null
  }
}

/** The supervisor that the lock names, if it is alive and owns the lock's port. */
function supervisorOf(home: string, root: string): { pid: number; port: number } | null {
  const lock = lockOf(home, root)
  if (!lock || !isAlive(lock.pid)) return null
  return listeningPorts([lock.pid]).includes(lock.port) ? { pid: lock.pid, port: lock.port } : null
}

/** The core is the supervisor's child that runs `server/main.ts`. Tool processes come and go, so the check uses only these two. */
function coreOf(pid: number): number | undefined {
  const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
  const row = rows.find((line) => Number(line.trim().split(/\s+/)[1]) === pid && line.includes('server/main.ts'))
  return row ? Number(row.trim().split(/\s+/)[0]) : undefined
}

function psField(pid: number, field: string): string {
  try {
    return execFileSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
  } catch {
    return ''
  }
}

async function act(port: number, path: string, body: object) {
  const origin = `http://127.0.0.1:${port}`
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  return (await response.json()) as { result: unknown }
}

const statusAnswers = (port: number) => act(port, '/api/extensions/status/actions/status', { args: {} }).then(() => true, () => false)
const busyOf = async (port: number) => ((await act(port, '/api/extensions/status/actions/status', { args: {} })).result as { busy?: number }).busy ?? 0

async function submit(port: number, text: string) {
  const { result: conversation } = await until('the standing conversation', () =>
    act(port, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } }).catch(() => null), 60000)
  await act(port, `/api/conversations/${conversation}/submit`, { text })
}

/** A login profile that puts a folder first on PATH, with an `open` that records any call, as a Chrome window would need. */
function loginProfile(home: string, extra = ''): { marker: string; openLog: string } {
  const marker = join(home, 'marker-bin')
  const openLog = join(home, 'open-calls.log')
  mkdirSync(marker, { recursive: true })
  writeFileSync(join(marker, 'open'), `#!/bin/sh\necho "$@" >> '${openLog}'\n`, { mode: 0o755 })
  writeFileSync(join(home, '.zprofile'), `${extra}export PATH="${marker}:$PATH"\n`)
  return { marker, openLog }
}

const finderEnv = (home: string, agentDir: string, extra: Record<string, string> = {}) => ({ HOME: home, PATH: FINDER_PATH, PI_CODING_AGENT_DIR: agentDir, ...extra })

const lifeOf = (hub: Hub, label: string): Promise<Life> =>
  hub.topRow(label).evaluate((row) => {
    const button = row.querySelector<HTMLButtonElement>('.life')
    return button ? { name: button.ariaLabel!, kind: [...button.classList].find((name) => name !== 'life')!, disabled: button.disabled } : null
  })

/** Records each accessible name that the row's lifecycle control takes, so that a short state is not missed. */
function recordLife(hub: Hub, root: string): Promise<void> {
  return hub.shell().evaluate((root) => {
    const seen: string[] = []
    ;(window as unknown as { lifeSeen: string[] }).lifeSeen = seen
    const read = () => {
      const row = document.querySelector(`#top .tab[data-root="${CSS.escape(root)}"]`)
      const name = row ? (row.querySelector('.life')?.ariaLabel ?? '(no control)') : '(no row)'
      if (seen.at(-1) !== name) seen.push(name)
    }
    new MutationObserver(read).observe(document.querySelector('#top')!, { subtree: true, childList: true, attributes: true })
    read()
  }, root)
}

const lifeSeen = (hub: Hub) => hub.shell().evaluate(() => (window as unknown as { lifeSeen: string[] }).lifeSeen)

const savedLifecycle = (hub: Hub, root: string) => hub.savedTabs().find((tab) => tab.root === root)?.lifecycle

async function waitForLife(hub: Hub, label: string, name: string, timeout = 60000): Promise<void> {
  await until(`${label} control named ${name}`, async () => (await lifeOf(hub, label).catch(() => null))?.name === name, timeout)
}

async function sheetsAfter(hub: Hub, count: number) {
  return until(`sheet ${count + 1}`, async () => {
    const shown = await hub.sheetsShown()
    return shown.length > count ? shown : null
  }, 15000)
}

/** Closes through the row's trailing menu (native menu stubbed). */
async function chooseClose(hub: Hub, label: string) {
  await hub.planMenus(['Close Ultimate…'])
  await hub.topRow(label).locator('.row-menu').click()
}

/** Ends a supervisor that the app started for this run. It checks the command line first, and never signals another process. */
async function stopStarted(pid: number, root: string) {
  if (!isAlive(pid)) return
  const args = psField(pid, 'args')
  if (!args.includes(root)) throw new Error(`pid ${pid} is not ours: ${args}`)
  const tree = processTree(pid)
  process.kill(pid, 'SIGTERM')
  await until(`${root} and its children to exit`, () => tree.every((child) => !isAlive(child)), 20000)
}

export async function runLifecycleChecks(check: Check) {
  const started: { pid: number; root: string }[] = []
  try {
    await runRealChecks(check, started)
    await runProbeChecks(check, started)
    await runStubChecks(check)
  } finally {
    for (const { pid, root } of started) await stopStarted(pid, root)
  }
}

async function runRealChecks(check: Check, started: { pid: number; root: string }[]) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const model = await startScriptedModel()
  const { openLog } = loginProfile(home)
  const [rootA, rootB, rootC] = ['alpha', 'beta', 'gamma'].map((name) => makeProject(projects, name))
  // If the app passed these on, Ultimate would hide in another folder or fail on port 1.
  const env = finderEnv(home, model.agentDir, { ULTIMATE_HOME: join(home, 'not-here'), ULTIMATE_PORT: '1' })
  const alpha = startUltimate(home, rootA, model.agentDir)
  const beta = startUltimate(home, rootB, model.agentDir)
  let hub = await Hub.launch(home, userData, env)
  const relaunch = async () => {
    hub = await Hub.launch(home, userData, env)
    await hub.spyOnProcesses()
    await hub.planSheets([])
  }
  const shot = (name: string) => hub.screenshot(join(EVIDENCE, name))
  const remember = (pid: number, root: string) => started.push({ pid, root })
  try {
    await hub.spyOnProcesses()
    const portA = await alpha.port()
    const portB = await beta.port()
    await until('both rows', async () => (await hub.labels()).join() === 'alpha,beta', 30000)
    await hub.select('beta')
    const pidA = alpha.child.pid!
    const pidB = beta.child.pid!
    const startA = psField(pidA, 'lstart')
    const startB = psField(pidB, 'lstart')

    await check(section, 'AC 17 and 1: running rows have native Pause buttons named Pause <name>, the sheet covers the page, and a real Return on Cancel changes no process', async () => {
      assert.deepEqual(await lifeOf(hub, 'alpha'), { name: 'Pause alpha', kind: 'pause', disabled: false })
      assert.deepEqual(await lifeOf(hub, 'beta'), { name: 'Pause beta', kind: 'pause', disabled: false })
      assert.equal(await hub.topRow('alpha').locator('.life').evaluate((button: HTMLElement) => button.tagName + button.title), 'BUTTONPause alpha')
      await hub.planSheets(['hold'])
      await hub.topRow('alpha').locator('.life').click()
      await sheetsAfter(hub, 0)
      assert.equal(await hub.shellOnTop(), true, 'the sheet is over the page')
      await sleep(300)
      await shot('lifecycle-00-pause-sheet.png')
      await hub.shell().keyboard.press('Enter')
      const [sheet] = await until('the answer', async () => ((await hub.sheetsShown())[0].answer ? hub.sheetsShown() : null), 3000)
      assert.deepEqual(sheet, { title: 'Pause alpha?', text: PAUSE_WARNING, path: rootA, buttons: ['Cancel', 'Pause server'], focused: 'sheet-cancel', answer: 'cancel' })
      await until('the shell goes back under the page', async () => !(await hub.shellOnTop()), 2000)
      await sleep(1500)
      assert.deepEqual((await hub.processCalls()).signals, [], 'no signal')
      assert.deepEqual([psField(pidA, 'lstart'), psField(pidB, 'lstart')], [startA, startB], 'both start times are the same')
      assert.deepEqual(supervisorOf(home, rootA), { pid: pidA, port: portA })
      assert.equal((await lifeOf(hub, 'alpha'))?.name, 'Pause alpha')
      assert.equal(savedLifecycle(hub, rootA), null)
      return `sheet "${sheet.title}" over the page, with the approved warning and the project path, buttons Cancel and Pause server, and the keyboard on Cancel. Return answered Cancel. No signal. Screenshot lifecycle-00-pause-sheet.png. Supervisors ${pidA} and ${pidB} kept start times "${startA}" and "${startB}".`
    })

    const treeA = processTree(pidA)
    let launcher: unknown
    let holdRequests = 0
    await check(section, 'AC 7 and 2: pause during active scripted work shows the resume warning, sends one SIGTERM to that supervisor only, and shows Play after the exit', async () => {
      await submit(portA, 'hold-turn')
      await until('alpha busy', async () => (await busyOf(portA)) > 0, 30000)
      holdRequests = holdTurns(model.requests)
      const coreB = coreOf(pidB)
      await recordLife(hub, rootA)
      await hub.planSheets(['action'])
      await hub.topRow('alpha').locator('.life').click()
      await waitForLife(hub, 'alpha', 'Start alpha', 30000)
      const [, sheet] = await hub.sheetsShown()
      assert.deepEqual([sheet.text, sheet.path, sheet.answer], [PAUSE_WARNING, rootA, 'action'])
      assert.deepEqual((await hub.processCalls()).signals, [{ pid: pidA, signal: 'SIGTERM' }])
      const seen = await lifeSeen(hub)
      // The row leaves Status when it stops, and the sidebar holds such a change for 500 ms after a click. A stop that ends
      // in that time is drawn as Pause, then Start. The signal and the exit, checked here, are what make Start correct.
      assert.ok(['Pause alpha,Stopping alpha,Start alpha', 'Pause alpha,Start alpha'].includes(seen.join()), `Play appears only after the stop: ${seen.join(' → ')}`)
      assert.ok(treeA.every((pid) => !isAlive(pid)), `alpha tree ${treeA.join(',')} is gone`)
      assert.equal(coreOf(pidB), coreB, 'the core of beta is the same process')
      assert.equal(psField(pidB, 'lstart'), startB)
      assert.ok(await statusAnswers(portB), 'beta still answers')
      const row = await hub.tab('alpha')
      assert.deepEqual(row && { port: row.port, dimmed: row.dimmed, selected: row.selected }, { port: null, dimmed: true, selected: false })
      assert.equal(await hub.topRow('alpha').locator('.state').innerText(), 'Paused')
      assert.equal(await hub.groupOf('alpha'), undefined, 'a paused row has no status row')
      launcher = savedLifecycle(hub, rootA)
      assert.deepEqual(launcher, { kind: 'paused', launcher: { node: NODE, entry: ENTRY } })
      await settled(home, rootB, await hub.shownPage())
      await shot('lifecycle-01-paused-row.png')
      return `the warning was shown during a hold-turn. One SIGTERM to ${pidA}. The control went ${seen.join(' → ')}. ${treeA.length} alpha processes are gone, beta's supervisor and core ${coreB} are unchanged and answer. tabs.json saved ${JSON.stringify(launcher)}. Screenshot lifecycle-01-paused-row.png`
    })

    await check(section, 'AC 3: a paused unnamed, unselected row keeps its place and stays paused after the app restarts', async () => {
      await hub.quit()
      await relaunch()
      await until('rows', async () => (await hub.labels()).join() === 'alpha,beta', 15000)
      await waitForLife(hub, 'alpha', 'Start alpha', 5000)
      assert.equal((await hub.tab('alpha'))?.selected, false)
      assert.equal(await hub.groupOf('alpha'), undefined)
      await hub.select('alpha')
      await until('the paused message', async () => (await hub.message()) === 'Paused', 5000)
      assert.equal((await hub.shown()).visible.length, 0, 'no page view for a paused row')
      await shot('lifecycle-02-paused-selected.png')
      return `after a restart the list is alpha, beta, alpha shows Start alpha and was not selected. Selected, it shows "${await hub.message()}". Screenshot lifecycle-02-paused-selected.png`
    })

    let gamma: ReturnType<typeof startUltimate>
    let pidA2 = 0
    let portA2 = 0
    await check(section, 'AC 4, 5, and 13: Play from a Finder environment starts the same project on another port, resumes the interrupted turn, and opens no Chrome window', async () => {
      gamma = startUltimate(home, rootC, model.agentDir, { port: portA })
      await until('gamma on the old port of alpha', () => supervisorOf(home, rootC)?.port === portA, 60000)
      await until('gamma row', () => hub.tab('gamma'), 10000)
      await recordLife(hub, rootA)
      await hub.topRow('alpha').locator('.life').click()
      await waitForLife(hub, 'alpha', 'Pause alpha', 60000)
      const { spawns, signals } = await hub.processCalls()
      assert.equal(spawns.length, 1, JSON.stringify(spawns))
      assert.deepEqual({ file: spawns[0].file, args: spawns[0].args }, { file: NODE, args: [ENTRY, rootA, '--no-open'] })
      assert.deepEqual(signals, [])
      assert.deepEqual(await hub.sheetsShown(), [], 'Play asks nothing')
      const seen = await lifeSeen(hub)
      assert.deepEqual(seen, ['Start alpha', 'Starting alpha', 'Pause alpha'])
      const now = supervisorOf(home, rootA)!
      pidA2 = now.pid
      portA2 = now.port
      remember(pidA2, rootA)
      assert.equal(pidA2, spawns[0].pid, 'the lock names the process that the app started')
      assert.notEqual(portA2, portA, 'another port, because gamma holds the old one')
      assert.equal(savedLifecycle(hub, rootA), null)
      const page = await showProject(hub, 'alpha', rootA)
      assert.equal(new URL(page.url()).port, String(portA2))
      await until('the interrupted turn is sent again', () => holdTurns(model.requests) > holdRequests, 30000)
      await until('the history shows the earlier message', async () => (await page.locator('body').innerText()).includes('hold-turn'), 30000)
      model.release()
      await settled(home, rootA, page)
      assert.equal(existsSync(openLog) ? readFileSync(openLog, 'utf8') : '', '', 'no open call')
      await shot('lifecycle-03-after-play.png')
      return `one spawn of ${NODE} ${ENTRY} ${rootA} --no-open, from an app with PATH ${FINDER_PATH}. The control went ${seen.join(' → ')}. Alpha came back as pid ${pidA2} on ${portA2} (gamma holds ${portA}), the page is alpha's, the scripted model got the hold-turn request again, and the history shows it. No open call. Screenshot lifecycle-03-after-play.png`
    })

    await check(section, 'AC 6: after Play, quitting the app leaves the new supervisor running on its own, and the reopened app finds it', async () => {
      await hub.quit()
      assert.ok(isAlive(pidA2))
      assert.equal(psField(pidA2, 'ppid'), '1')
      assert.ok(await statusAnswers(portA2), 'its status action answers')
      await relaunch()
      await until('alpha running again', async () => (await hub.tab('alpha'))?.port === portA2, 15000)
      assert.equal((await lifeOf(hub, 'alpha'))?.name, 'Pause alpha')
      return `pid ${pidA2} kept running with ppid 1 and answered on ${portA2}. The reopened app shows alpha on ${portA2} with Pause.`
    })

    await check(section, 'AC 9: five fast clicks give one sheet and one SIGTERM, and five fast clicks on Start give one spawn', async () => {
      await hub.planSheets(['action'])
      await hub.topRow('alpha').locator('.life').evaluate((button: HTMLButtonElement) => {
        for (let click = 0; click < 5; click++) button.click()
      })
      await waitForLife(hub, 'alpha', 'Start alpha', 30000)
      await sleep(500)
      const afterPause = await hub.processCalls()
      assert.equal((await hub.sheetsShown()).length, 1)
      assert.deepEqual(afterPause.signals, [{ pid: pidA2, signal: 'SIGTERM' }])
      await hub.topRow('alpha').locator('.life').evaluate((button: HTMLButtonElement) => {
        for (let click = 0; click < 5; click++) button.click()
      })
      await waitForLife(hub, 'alpha', 'Pause alpha', 60000)
      await sleep(500)
      const { spawns, signals } = await hub.processCalls()
      assert.equal(spawns.length, 1, JSON.stringify(spawns))
      assert.equal(signals.length, 1)
      remember(spawns[0].pid!, rootA)
      return `1 sheet and 1 SIGTERM (to ${pidA2}) for five clicks on Pause. 1 spawn (pid ${spawns[0].pid}) for five clicks on Start.`
    })

    await check(section, 'AC 12: a start outside the app while paused, or while the app starts it, is adopted and never signalled', async () => {
      const before = (await hub.processCalls()).signals.length
      await hub.planSheets(['action'])
      await hub.topRow('alpha').locator('.life').click()
      await waitForLife(hub, 'alpha', 'Start alpha', 30000)
      const outside = startUltimate(home, rootA, model.agentDir)
      await until('the outside start adopted', async () => (await lifeOf(hub, 'alpha'))?.name === 'Pause alpha', 60000)
      assert.equal(savedLifecycle(hub, rootA), null, 'the record is cleared')
      assert.equal(supervisorOf(home, rootA)?.pid, outside.child.pid)
      await hub.planSheets(['action'])
      await hub.topRow('alpha').locator('.life').click()
      await waitForLife(hub, 'alpha', 'Start alpha', 30000)
      const spawnsBefore = (await hub.processCalls()).spawns.length
      await hub.topRow('alpha').locator('.life').click()
      const racer = startUltimate(home, rootA, model.agentDir)
      await waitForLife(hub, 'alpha', 'Pause alpha', 60000)
      const { signals, spawns } = await hub.processCalls()
      const mine = spawns.slice(spawnsBefore)
      const winner = supervisorOf(home, rootA)!
      assert.equal(signals.length, before + 2, 'only the two pauses signalled')
      assert.ok([racer.child.pid, ...mine.map(({ pid }) => pid)].includes(winner.pid))
      for (const { pid } of mine) remember(pid!, rootA)
      await sleep(2000)
      const alive = [racer.child.pid!, ...mine.map(({ pid }) => pid!)].filter(isAlive)
      assert.deepEqual(alive, [winner.pid], "Ultimate's lock refused the second start")
      assert.equal((await hub.processCalls()).signals.length, before + 2)
      return `while paused, the outside pid ${outside.child.pid} was adopted and the record cleared. In the race, ${winner.pid === racer.child.pid ? 'the outside start' : "the app's start"} won (pid ${winner.pid}), the other exited, and the app sent no signal beyond its two pauses.`
    })

    await check(section, 'AC 17: keyboard and pointer: Tab reaches the control, Space opens the sheet, Enter opens the row menu, and clicks, double-clicks, or drags on a control never select, rename, or move the row', async () => {
      await hub.select('beta')
      await until('beta selected', async () => (await hub.tab('beta'))?.selected)
      await hub.shell().locator('#add').focus()
      const passed: string[] = []
      for (let step = 0; step < 20 && (await hub.focusedInShell()) !== `life:${rootA}`; step++) {
        await hub.shell().keyboard.press('Tab')
        passed.push(await hub.focusedInShell())
      }
      assert.equal(await hub.focusedInShell(), `life:${rootA}`, passed.join(', '))
      const sheets = (await hub.sheetsShown()).length
      await hub.planSheets(['cancel'])
      await hub.shell().keyboard.press('Space')
      const space = (await sheetsAfter(hub, sheets).catch(async (error) => {
        throw new Error(`${error.message}. Focus ${await hub.focusedInShell()}, control ${JSON.stringify(await lifeOf(hub, 'alpha'))}, log: ${hub.log().slice(-600)}`)
      })).at(-1)!
      assert.equal(space.title, 'Pause alpha?')
      await hub.shell().keyboard.press('Tab')
      assert.equal(await hub.focusedInShell(), `rowmenu:${rootA}`)
      await hub.planMenus([null])
      await hub.shell().keyboard.press('Enter')
      const menu = await until('the row menu', async () => (await hub.menusShown()).at(-1), 3000)
      assert.deepEqual(menu.items.map(({ label }) => label), ['Rename', 'Close Ultimate…'])
      await hub.planSheets(['cancel'])
      await hub.topRow('alpha').locator('.life').click()
      await sheetsAfter(hub, sheets + 1)
      await hub.topRow('alpha').locator('.life').dblclick()
      await sleep(300)
      assert.equal(await hub.shell().locator('input.rename').count(), 0, 'no rename')
      const order = JSON.stringify(hub.savedTabs())
      await hub.topRow('alpha').locator('.life').dragTo(hub.topRow('gamma'), { targetPosition: { x: 40, y: 30 } })
      await sleep(500)
      assert.equal(JSON.stringify(hub.savedTabs()), order, 'a drag from the control moved nothing')
      assert.equal((await hub.tab('beta'))?.selected, true, 'beta is still selected')
      await hub.drag('alpha', 'gamma', 'bottom')
      await until('a drag from the row still moves it', async () => (await hub.labels()).join() === 'beta,gamma,alpha', 3000)
      await shot('lifecycle-04-controls.png')
      return `Tab went ${passed.join(', ')}. Space opened "${space.title}", Enter on the menu button opened ${menu.items.map(({ label }) => label).join(', ')}. A click opened the sheet, a double-click opened no rename, a drag from the control moved nothing, and beta stayed selected. A drag from the row itself still moved it. Screenshot lifecycle-04-controls.png`
    })

    await check(section, 'AC 14: Cancel on the Close sheet changes nothing, and Close on one of two stops only it, then removes its row and keeps its group', async () => {
      const pidNow = supervisorOf(home, rootA)!.pid
      await hub.shell().evaluate((root) => {
        const send = (window as unknown as { hub: { send: (command: object) => void } }).hub.send
        send({ type: 'create-group', id: 'g-keep', name: 'Keep' })
        send({ type: 'move-to-group', root, groupId: 'g-keep' })
      }, rootA)
      await until('alpha in Keep', async () => (await hub.topNames()).some(([name, labels]) => name === 'Keep' && labels.includes('alpha')), 3000)
      await hub.rename('alpha', 'Alpha Renamed')
      await until('renamed', () => hub.tab('Alpha Renamed'), 3000)
      const sheets = (await hub.sheetsShown()).length
      const signals = (await hub.processCalls()).signals.length
      await hub.planSheets(['cancel'])
      await chooseClose(hub, 'Alpha Renamed')
      const cancel = (await sheetsAfter(hub, sheets)).at(-1)!
      assert.deepEqual(cancel, { title: 'Close Alpha Renamed?', text: CLOSE_WARNING, path: rootA, buttons: ['Cancel', 'Close Ultimate'], focused: 'sheet-cancel', answer: 'cancel' })
      await sleep(1000)
      assert.equal((await hub.processCalls()).signals.length, signals)
      assert.ok(await hub.tab('Alpha Renamed'))
      await hub.select('Alpha Renamed')
      await recordLife(hub, rootA)
      await hub.planSheets(['action'])
      await chooseClose(hub, 'Alpha Renamed')
      await until('the row leaves', async () => !(await hub.tab('Alpha Renamed')), 30000)
      const calls = await hub.processCalls()
      assert.deepEqual(calls.signals.slice(signals), [{ pid: pidNow, signal: 'SIGTERM' }])
      assert.deepEqual(await lifeSeen(hub), ['Pause Alpha Renamed', 'Closing Alpha Renamed', '(no row)'])
      assert.equal(hub.savedTabs().some((tab) => tab.root === rootA), false)
      assert.ok(hub.saved().groups.some((group) => group.name === 'Keep'), 'the empty group stays')
      assert.ok(await statusAnswers(portB), 'beta still answers')
      assert.equal((await hub.topRows()).find((row) => row.selected)?.label, 'beta', 'the selection moved to the next visible row')
      await shot('lifecycle-05-closed.png')
      return `Cancel showed "${cancel.title}" with the approved text and changed nothing. Close sent one SIGTERM to ${pidNow}, the control went ${(await lifeSeen(hub)).join(' → ')}, tabs.json lost alpha and kept the Keep group, and beta became selected. Screenshot lifecycle-05-closed.png`
    })

    await check(section, 'AC 16: a closed project started outside the app returns under its folder name, at the end of Ungrouped, with its conversation', async () => {
      startUltimate(home, rootA, model.agentDir)
      await until('alpha returns', () => hub.tab('alpha'), 60000)
      assert.deepEqual(await hub.topNames(), [['Keep', []], ['Ungrouped', ['beta', 'gamma', 'alpha']]])
      const page = await showProject(hub, 'alpha', rootA)
      await until('the earlier conversation', async () => (await page.locator('body').innerText()).includes('hold-turn'), 30000)
      await settled(home, rootA, page)
      await shot('lifecycle-06-closed-returns.png')
      return `alpha came back as "alpha" at the end of Ungrouped, not in Keep, and its page shows the hold-turn message. Screenshot lifecycle-06-closed-returns.png`
    })

    await check(section, 'AC 11: a crash right after the paused record saves leaves the server running, and the reopened app clears the record and sends nothing', async () => {
      const target = supervisorOf(home, rootA)!
      await hub.planSheets(['action'])
      await hub.evaluate((_electron, root) => {
        const fs = process.getBuiltinModule('node:fs') as unknown as Record<string, (...args: unknown[]) => unknown>
        const real = fs.renameSync
        fs.renameSync = (from: unknown, to: unknown) => {
          real(from, to)
          const text = (fs.readFileSync as (path: unknown, encoding: string) => string)(to, 'utf8')
          if (String(to).endsWith('tabs.json') && text.includes('"paused"') && text.includes(root as string)) process.kill(process.pid, 'SIGKILL')
        }
      }, rootA)
      await hub.topRow('alpha').locator('.life').click().catch(() => {})
      await until('the app to exit', () => !hub.windowsAlive(), 15000)
      assert.equal((JSON.parse(readFileSync(join(userData, 'tabs.json'), 'utf8')).tabs.find((tab: { root: string }) => tab.root === rootA)).lifecycle.kind, 'paused')
      assert.ok(isAlive(target.pid), 'no signal was sent')
      await relaunch()
      await waitForLife(hub, 'alpha', 'Pause alpha', 15000)
      await until('the record cleared', () => savedLifecycle(hub, rootA) === null, 5000)
      await sleep(1500)
      assert.deepEqual(await hub.processCalls(), { signals: [], spawns: [] })
      assert.equal(supervisorOf(home, rootA)?.pid, target.pid)
      return `the app exited right after tabs.json held the paused record. Pid ${target.pid} kept running. The reopened app showed alpha running, cleared the record, and sent no signal and started nothing.`
    })

    await check(section, 'AC 11: a crash right after the SIGTERM leaves the row paused after the reopen, with no new signal or start', async () => {
      const target = supervisorOf(home, rootA)!
      await hub.planSheets(['action'])
      await hub.evaluate(() => {
        const real = process.kill.bind(process)
        process.kill = ((pid: number, signal?: string | number) => {
          const result = real(pid, signal)
          if (signal === 'SIGTERM') real(process.pid, 'SIGKILL')
          return result
        }) as typeof process.kill
      }, null)
      await hub.topRow('alpha').locator('.life').click().catch(() => {})
      await until('the app to exit', () => !hub.windowsAlive(), 15000)
      await until('alpha to stop', () => !isAlive(target.pid), 20000)
      await relaunch()
      await waitForLife(hub, 'alpha', 'Start alpha', 15000)
      await sleep(1500)
      assert.deepEqual(await hub.processCalls(), { signals: [], spawns: [] })
      assert.deepEqual(savedLifecycle(hub, rootA), { kind: 'paused', launcher: { node: NODE, entry: ENTRY } })
      return `the app exited right after its SIGTERM to ${target.pid}, which then exited. The reopened app showed alpha paused and sent nothing.`
    })

    await check(section, 'AC 13: Play works in an app that LaunchServices opened, as Finder would, with only HOME and the agent folder added', async () => {
      await hub.quit()
      const bundle = APP.replace(/\/Contents\/MacOS\/.*$/, '')
      const stderr = join(tempDir('open'), 'stderr.txt')
      execFileSync('/usr/bin/open', ['-n', '--env', `HOME=${home}`, '--env', `PI_CODING_AGENT_DIR=${model.agentDir}`, '--stderr', stderr, bundle, '--args', `--user-data-dir=${userData}`, '--inspect=0'])
      const mainPid = await until('the app process', () => {
        const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
        const row = rows.find((line) => line.includes(`--user-data-dir=${userData}`) && !line.includes('--type='))
        return row ? Number(row.trim().split(/\s+/)[0]) : null
      })
      let close = () => {}
      try {
        const url = await until('the inspector address', () => (existsSync(stderr) ? readFileSync(stderr, 'utf8').match(/ws:\/\/\S+/)?.[0] : undefined), 15000)
        const driver = await inspector(url)
        const inShell = driver.inShell
        close = driver.close
        await until('alpha paused in the opened app', () => inShell(`document.querySelector('#top .tab[data-root="${rootA}"] .life')?.ariaLabel === 'Start alpha'`), 15000)
        await inShell(`document.querySelector('#top .tab[data-root="${rootA}"] .life').click()`)
        const now = await until('alpha started by the opened app', () => {
          const found = supervisorOf(home, rootA)
          return found && psField(found.pid, 'ppid') === String(mainPid) ? found : null
        }, 60000)
        remember(now.pid, rootA)
        await until('Pause alpha', () => inShell(`document.querySelector('#top .tab[data-root="${rootA}"] .life')?.ariaLabel === 'Pause alpha'`), 60000)
        assert.ok(await statusAnswers(now.port))
        return `the app opened through /usr/bin/open (pid ${mainPid}) started alpha as pid ${now.pid} on ${now.port}, which answers. The click was a DOM click through the inspector, because this app has no Playwright driver.`
      } finally {
        close()
        process.kill(mainPid, 'SIGTERM')
        await until('the opened app to exit', () => !isAlive(mainPid), 15000)
      }
    })
  } finally {
    for (const root of [rootA, rootB, rootC]) {
      const left = supervisorOf(home, root)
      if (left) remember(left.pid, root)
    }
    if (hub.windowsAlive()) await hub.quit().catch(() => hub.forceStop())
    model.release()
    model.close()
  }
}

/** A minimal driver for an app that the test did not spawn: it runs code in the sidebar through the main process inspector. */
/** Close it before the app quits, because Node's inspector holds the process at exit until the debugger disconnects. */
async function inspector(url: string): Promise<{ inShell: (code: string) => Promise<unknown>; close: () => void }> {
  const socket = new WebSocket(url)
  await once(socket as unknown as EventTarget, 'open')
  let nextId = 1
  const waiting = new Map<number, (value: unknown) => void>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    waiting.get(message.id)?.(message.result?.result?.value)
  })
  const inShell = (code: string) => {
    const id = nextId++
    const expression = `require('electron').BaseWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript(${JSON.stringify(code)})`
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
    return new Promise((resolve) => waiting.set(id, resolve))
  }
  return { inShell, close: () => socket.close() }
}

/** A folder that looks like an Ultimate clone, whose entry runs `code` instead. */
function fakeClone(parent: string, name: string, code: string): string {
  const clone = join(parent, name)
  mkdirSync(join(clone, 'bin'), { recursive: true })
  writeFileSync(join(clone, 'package.json'), JSON.stringify({ name: 'ultimate' }))
  writeFileSync(join(clone, 'bin/ultimate.ts'), code)
  return realpathSync(join(clone, 'bin/ultimate.ts'))
}

const PROBE = `import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2] + '/probe.json', JSON.stringify({ path: process.env.PATH, home: process.env.ULTIMATE_HOME ?? null, port: process.env.ULTIMATE_PORT ?? null, argv: process.argv.slice(1), cwd: process.cwd() }))
process.stderr.write('probe: wrote probe.json\\n')
process.exit(1)
`

async function runProbeChecks(check: Check, started: { pid: number; root: string }[]) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const fakes = tempDir('fakes')
  const { marker } = loginProfile(home)
  const probe = fakeClone(fakes, 'probe', PROBE)
  const waiter = fakeClone(fakes, 'waiter', "process.stderr.write('waiter: never listens\\n')\nsetInterval(() => {}, 1000)\nprocess.on('SIGTERM', () => process.exit(0))\n")
  const [probeRoot, waitRoot, nodeRoot] = ['probe', 'waiter', 'no-node'].map((name) => makeProject(projects, name))
  const goneRoot = join(projects, 'renamed-away')
  const paused = (root: string, node: string, entry: string) => ({ root, name: null, groupId: null, lifecycle: { kind: 'paused', launcher: { node, entry } } })
  writeFileSync(
    join(userData, 'tabs.json'),
    JSON.stringify({ groups: [], tabs: [paused(probeRoot, NODE, probe), paused(waitRoot, NODE, waiter), paused(nodeRoot, '/nonexistent/bin/node', ENTRY), paused(goneRoot, NODE, ENTRY)] }),
  )
  const hub = await Hub.launch(home, userData, finderEnv(home, tempDir('agent'), { ULTIMATE_HOME: join(home, 'not-here'), ULTIMATE_PORT: '1' }))
  try {
    await hub.spyOnProcesses()
    await hub.planSheets([])
    await until('four paused rows', async () => (await hub.labels()).length === 4)

    await check(section, 'AC 10 and 13: a start that exits early returns the row to paused with the last stderr line, and the child got the login shell PATH without ULTIMATE_HOME or ULTIMATE_PORT', async () => {
      await hub.topRow('probe').locator('.life').click()
      await until('the error on the row', async () => (await hub.topRows()).length && (await hub.topRow('probe').locator('.error-mark').count()) === 1, 30000)
      assert.equal((await lifeOf(hub, 'probe'))?.name, 'Start probe')
      assert.equal(await hub.topRow('probe').locator('.error-mark').getAttribute('aria-label'), 'probe: wrote probe.json')
      const seen = JSON.parse(readFileSync(join(probeRoot, 'probe.json'), 'utf8'))
      const path: string[] = seen.path.split(':')
      assert.equal(path[0], marker, 'the login profile put its folder first')
      assert.equal(path.at(-1), dirname(NODE), 'the folder of Node comes last')
      assert.deepEqual([seen.home, seen.port], [null, null])
      assert.deepEqual(seen.argv, [probe, probeRoot, '--no-open'])
      assert.equal(seen.cwd, probeRoot)
      assert.deepEqual(savedLifecycle(hub, probeRoot), { kind: 'paused', launcher: { node: NODE, entry: probe } }, 'a failed start keeps the record')
      await hub.select('probe')
      await until('the message', async () => (await hub.message()).includes('probe: wrote probe.json'), 5000)
      assert.equal(await hub.shell().locator('#message .retry').innerText(), 'Start')
      await hub.screenshot(join(EVIDENCE, 'lifecycle-07-start-failed.png'))
      return `the row is paused with the error "probe: wrote probe.json". The child saw PATH ${seen.path}, no ULTIMATE_HOME or ULTIMATE_PORT, argv ${seen.argv.join(' ')}, cwd ${seen.cwd}. The main area offers Start. Screenshot lifecycle-07-start-failed.png`
    })

    await check(section, 'AC 10: a missing Node and a missing project folder refuse Play in a sheet, start nothing, and keep the rows paused', async () => {
      const spawns = (await hub.processCalls()).spawns.length
      await hub.planSheets(['action', 'action'])
      await hub.topRow('no-node').locator('.life').click()
      await hub.topRow('renamed-away').locator('.life').click()
      const sheets = await until('two sheets', async () => ((await hub.sheetsShown()).length === 2 ? hub.sheetsShown() : null), 10000)
      assert.deepEqual(sheets.map(({ title, text, buttons }) => [title, text, buttons]).sort(), [
        ['Hub could not start no-node', 'Node is not available at /nonexistent/bin/node.', ['OK']],
        ['Hub could not start renamed-away', `The project folder is missing: ${goneRoot}`, ['OK']],
      ])
      assert.equal((await hub.processCalls()).spawns.length, spawns)
      assert.equal((await lifeOf(hub, 'no-node'))?.name, 'Start no-node')
      assert.equal((await lifeOf(hub, 'renamed-away'))?.name, 'Start renamed-away')
      return `sheets: ${sheets.map(({ text }) => `"${text}"`).join(' and ')}. No spawn. Both rows show Start.`
    })

    await check(section, 'AC 10: a start that never listens is late after 30 s and keeps its controls busy, then fails with its stderr when it exits', async () => {
      const spawnsBefore = (await hub.processCalls()).spawns.length
      await hub.topRow('waiter').locator('.life').click()
      const child = await until('the spawn', async () => (await hub.processCalls()).spawns[spawnsBefore], 5000)
      started.push({ pid: child.pid!, root: waitRoot })
      await waitForLife(hub, 'waiter', 'Starting waiter', 5000)
      const clickedAt = Date.now()
      await until('the late error', async () => (await hub.topRow('waiter').locator('.error-mark').count()) === 1, 40000)
      const lateAfter = Date.now() - clickedAt
      assert.ok(lateAfter >= 28000, `late after ${lateAfter} ms`)
      assert.equal(await hub.topRow('waiter').locator('.error-mark').getAttribute('aria-label'), 'Ultimate has not started after 30 seconds. Hub is still waiting.')
      assert.deepEqual(await lifeOf(hub, 'waiter'), { name: 'Starting waiter', kind: 'busy', disabled: true })
      await hub.planMenus([null])
      await hub.topRow('waiter').locator('.row-menu').click()
      const menu = await until('the row menu', async () => (await hub.menusShown()).at(-1), 3000)
      assert.deepEqual(menu.items.map(({ label, enabled }) => [label, enabled]), [['Rename', true], ['Remove from Hub', false]], 'Remove is disabled during a start')
      await hub.select('waiter')
      await hub.screenshot(join(EVIDENCE, 'lifecycle-08-start-late.png'))
      assert.ok(isAlive(child.pid!), 'the app did not kill it')
      await stopStarted(child.pid!, waitRoot)
      await waitForLife(hub, 'waiter', 'Start waiter', 10000)
      assert.equal(await hub.topRow('waiter').locator('.error-mark').getAttribute('aria-label'), 'waiter: never listens')
      assert.deepEqual((await hub.processCalls()).signals, [], 'the app sent no signal')
      return `late after ${lateAfter} ms with the busy control and a disabled Remove. The app never signalled pid ${child.pid}. When the test stopped it, the row went back to Start with "waiter: never listens". Screenshot lifecycle-08-start-late.png`
    })
  } finally {
    await hub.quit().catch(() => hub.forceStop())
  }

  await check(section, 'AC 13: a login shell that takes over 5 s is given up, logged, and the child gets the folder of Node before the app PATH', async () => {
    const slowHome = tempDir('home')
    const slowData = tempDir('data')
    writeFileSync(join(slowHome, '.zprofile'), 'sleep 7\n')
    const root = makeProject(tempDir('projects'), 'slow')
    writeFileSync(join(slowData, 'tabs.json'), JSON.stringify({ groups: [], tabs: [paused(root, NODE, probe)] }))
    const slow = await Hub.launch(slowHome, slowData, finderEnv(slowHome, tempDir('agent')))
    try {
      await until('the row', () => slow.tab('slow'))
      const clickedAt = Date.now()
      await slow.topRow('slow').locator('.life').click()
      await until('probe.json', () => existsSync(join(root, 'probe.json')), 20000)
      const waited = Date.now() - clickedAt
      const seen = JSON.parse(readFileSync(join(root, 'probe.json'), 'utf8'))
      assert.equal(seen.path, `${dirname(NODE)}:${FINDER_PATH}`)
      assert.ok(waited >= 5000 && waited < 9000, `waited ${waited} ms`)
      const line = slow.log().split('\n').find((text) => text.includes('login shell PATH'))
      assert.ok(line?.includes('so Hub uses its own PATH'), slow.log())
      await sleep(2500)
      return `the start waited ${waited} ms, logged "${line!.replace(/^\S+ /, '')}", and the child got PATH ${seen.path}`
    } finally {
      await slow.quit().catch(() => slow.forceStop())
    }
  })
}

async function runStubChecks(check: Check) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const root = (name: string) => join(projects, name)
  let hub = await Hub.launch(home, userData)
  const stubs = new Map<string, Stub>()
  const stub = async (name: string, mode = 'page') => {
    const started = await startStub(home, root(name), 0, mode)
    stubs.set(name, started)
    await until(`${name} row`, async () => (await hub.tab(name))?.port === started.port, 10000)
    return started
  }
  const prepare = async () => {
    await hub.spyOnProcesses()
    await hub.planSheets([])
    await hub.injectLsof({ count: 0 })
  }
  const signals = async () => (await hub.processCalls()).signals
  const noRecord = (name: string) => assert.equal(savedLifecycle(hub, root(name)), null, `${name} has no record`)
  try {
    await prepare()
    for (const name of ['alpha', 'beta', 'delta']) await stub(name)

    await check(section, 'AC 10: pause of a server whose restart setup cannot be found is refused in a sheet before any question', async () => {
      await hub.planSheets(['action'])
      await hub.topRow('alpha').locator('.life').click()
      const [sheet] = await sheetsAfter(hub, 0)
      assert.deepEqual([sheet.title, sheet.text, sheet.path, sheet.buttons, sheet.focused], ['Hub could not pause alpha', 'Hub cannot find how this Ultimate was started, so it could not start it again.', root('alpha'), ['OK'], 'sheet-action'])
      assert.deepEqual(await signals(), [])
      assert.equal(await hub.topRow('alpha').locator('.error-mark').getAttribute('aria-label'), sheet.text)
      return `"${sheet.title}": ${sheet.text} No signal, and the row shows the error.`
    })

    await check(section, 'AC 8: an lsof failure refuses Close before the question, and no signal is sent', async () => {
      const shown = (await hub.sheetsShown()).length
      await hub.injectLsof({ count: 2 })
      await hub.planSheets(['action'])
      await chooseClose(hub, 'alpha')
      const sheet = (await sheetsAfter(hub, shown)).at(-1)!
      assert.equal(sheet.text, 'Hub could not check the process (lsof failed).')
      await until('the injection to be used up', async () => (await hub.lsofFailuresSeen()) >= 2, 10000)
      assert.deepEqual(await signals(), [])
      noRecord('alpha')
      assert.ok(isAlive(stubs.get('alpha')!.child.pid!))
      return `sheet "${sheet.text}". No signal and no record.`
    })

    await check(section, 'AC 8 and 15: a lock rewritten to another live process while the sheet is open (PID reuse) refuses the stop', async () => {
      const shown = (await hub.sheetsShown()).length
      const alpha = stubs.get('alpha')!
      const beta = stubs.get('beta')!
      await hub.planSheets(['hold'])
      await chooseClose(hub, 'alpha')
      await sheetsAfter(hub, shown)
      writeLock(home, root('alpha'), { pid: beta.child.pid!, port: beta.port })
      await hub.planSheets(['action'])
      await hub.releaseSheet('action')
      const refusal = (await sheetsAfter(hub, shown + 1)).at(-1)!
      assert.equal(refusal.text, 'The Ultimate changed while the dialog was open.')
      assert.deepEqual(await signals(), [])
      noRecord('alpha')
      writeLock(home, root('alpha'), { pid: alpha.child.pid!, port: alpha.port })
      assert.ok(isAlive(alpha.child.pid!) && isAlive(beta.child.pid!))
      return `the lock of alpha named beta's pid ${beta.child.pid} after the question. The app refused with "${refusal.text}", sent no signal, and saved no record.`
    })

    await check(section, 'AC 8: a server that stops while the sheet is open, leaving a lock with a dead PID, is refused', async () => {
      const shown = (await hub.sheetsShown()).length
      await hub.planSheets(['hold'])
      await chooseClose(hub, 'delta')
      await sheetsAfter(hub, shown)
      const delta = stubs.get('delta')!
      await delta.stop()
      assert.ok(existsSync(join(projectHome(home, root('delta')), 'ultimate.lock')), 'the lock stays')
      await hub.planSheets(['action'])
      await hub.releaseSheet('action')
      const refusal = (await sheetsAfter(hub, shown + 1)).at(-1)!
      assert.equal(refusal.text, 'The process in the lock does not own its port.')
      assert.deepEqual(await signals(), [])
      return `refused with "${refusal.text}" for dead pid ${delta.child.pid}. No signal.`
    })

    await check(section, 'AC 8: a start time that changes at the last check before the signal refuses the stop and removes the saved record', async () => {
      const shown = (await hub.sheetsShown()).length
      await hub.planSheets(['hold'])
      await chooseClose(hub, 'alpha')
      await sheetsAfter(hub, shown)
      await hub.evaluate(() => {
        const module = process.getBuiltinModule('node:child_process') as unknown as Record<string, (...args: unknown[]) => unknown>
        const real = module.execFile
        let seen = 0
        module.execFile = (file: unknown, args: unknown, options: unknown, callback: unknown) => {
          if (String(file) !== '/bin/ps' || !(args as string[]).includes('uid=,lstart=')) return real(file, args, options, callback)
          seen++
          if (seen === 2) module.execFile = real
          return real(file, args, options, (error: unknown, stdout: string, stderr: string) =>
            (callback as (...parts: unknown[]) => void)(error, seen === 2 ? stdout.replace(/\d{4}\s*$/, '1999') : stdout, stderr))
        }
      }, null)
      await hub.planSheets(['action'])
      await hub.releaseSheet('action')
      const refusal = (await sheetsAfter(hub, shown + 1)).at(-1)!
      assert.equal(refusal.text, 'The process changed, so Hub did not stop it.')
      assert.deepEqual(await signals(), [])
      noRecord('alpha')
      assert.equal((await lifeOf(hub, 'alpha'))?.name, 'Pause alpha')
      return `the second ps read, in the signal step, gave year 1999. Refused with "${refusal.text}". The closing record was removed and no signal went out.`
    })

    await check(section, 'AC 10 and 15: a save failure before the signal refuses Close and sends nothing', async () => {
      const shown = (await hub.sheetsShown()).length
      chmodSync(userData, 0o555)
      try {
        await hub.planSheets(['action', 'action'])
        await chooseClose(hub, 'alpha')
        const refusal = (await sheetsAfter(hub, shown + 1)).at(-1)!
        assert.equal(refusal.text, 'Hub could not save tabs.json, so it did not stop the server.')
      } finally {
        chmodSync(userData, 0o755)
      }
      assert.deepEqual(await signals(), [])
      await sleep(1500)
      noRecord('alpha')
      return 'with the user data folder read-only, Close was refused with the save message, no signal went out, and tabs.json has no record after the folder came back.'
    })

    await check(section, 'AC 10 and 15: a stop that hangs is late after 15 s, keeps observing with one signal only, and ends when the process exits', async () => {
      const gamma = await stub('gamma', 'ignore-term')
      await hub.planSheets(['action'])
      await chooseClose(hub, 'gamma')
      await waitForLife(hub, 'gamma', 'Closing gamma', 5000)
      const at = Date.now()
      await until('the late error', async () => (await hub.topRow('gamma').locator('.error-mark').count()) === 1, 25000)
      const lateAfter = Date.now() - at
      assert.equal(await hub.topRow('gamma').locator('.error-mark').getAttribute('aria-label'), 'The server has not stopped after 15 seconds. Hub is still waiting and does not send another signal.')
      assert.deepEqual(await lifeOf(hub, 'gamma'), { name: 'Closing gamma', kind: 'busy', disabled: true })
      await hub.select('gamma')
      await until('Closing…', async () => (await hub.message()).startsWith('Closing…'), 3000)
      await hub.screenshot(join(EVIDENCE, 'lifecycle-09-stop-late.png'))
      assert.deepEqual(await signals(), [{ pid: gamma.child.pid!, signal: 'SIGTERM' }])
      await gamma.stop()
      await until('the row leaves', async () => !(await hub.tab('gamma')), 10000)
      assert.deepEqual(await signals(), [{ pid: gamma.child.pid!, signal: 'SIGTERM' }])
      return `late ${lateAfter} ms after Closing showed, with the busy control and "Closing…". One SIGTERM. After the test's own second SIGTERM ended the stub, the row left. Screenshot lifecycle-09-stop-late.png`
    })

    await check(section, 'AC 15: a replacement that starts right after the exit keeps the row, says that the instance changed, and is never signalled', async () => {
      const beta = stubs.get('beta')!
      await hub.evaluate(() => {
        const plan = (globalThis as unknown as { lsofPlan: { left: number; code: number; stderr: string } }).lsofPlan
        const real = process.kill.bind(process)
        process.kill = ((pid: number, signal?: string | number) => {
          const result = real(pid, signal)
          if (signal === 'SIGTERM') Object.assign(plan, { left: 4, code: 2, stderr: 'injected' })
          return result
        }) as typeof process.kill
      }, null)
      const before = (await signals()).length
      await hub.planSheets(['action'])
      await chooseClose(hub, 'beta')
      await until('beta to exit', () => beta.child.exitCode !== null, 10000)
      const replacement = await startStub(home, root('beta'))
      await until('the replacement adopted', async () => (await hub.tab('beta'))?.port === replacement.port, 15000)
      await until('the error', async () => (await hub.topRow('beta').locator('.error-mark').count()) === 1, 5000)
      assert.equal(await hub.topRow('beta').locator('.error-mark').getAttribute('aria-label'), INSTANCE_CHANGED)
      assert.deepEqual((await signals()).slice(before), [{ pid: beta.child.pid!, signal: 'SIGTERM' }])
      noRecord('beta')
      assert.ok(isAlive(replacement.child.pid!))
      stubs.set('beta', replacement)
      return `the old beta exited, and scans failed until the replacement (pid ${replacement.child.pid}) held the lock. The row stayed with "${INSTANCE_CHANGED}", and the only signal was to the old pid.`
    })

    await check(section, 'AC 15: a failed final save removes the row in the app and retries through the normal save, with no second signal', async () => {
      const alpha = stubs.get('alpha')!
      await hub.evaluate((_electron, rootA) => {
        const fs = process.getBuiltinModule('node:fs') as unknown as Record<string, (...args: unknown[]) => unknown>
        const real = fs.writeFileSync
        let failed = 0
        fs.writeFileSync = (path: unknown, data: unknown, ...rest: unknown[]) => {
          if (String(path).endsWith('tabs.json.tmp') && !String(data).includes(rootA as string) && failed < 2) {
            failed++
            throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
          }
          return real(path, data, ...rest)
        }
      }, root('alpha'))
      const before = (await signals()).length
      await hub.planSheets(['action'])
      await chooseClose(hub, 'alpha')
      await until('the row leaves', async () => !(await hub.tab('alpha')), 10000)
      await until('the retried save', () => !hub.savedTabs().some((tab) => tab.root === root('alpha')), 10000)
      assert.deepEqual((await signals()).slice(before), [{ pid: alpha.child.pid!, signal: 'SIGTERM' }])
      assert.ok(hub.log().includes('injected EACCES'), 'the failure is logged')
      return 'the removal save failed twice and the row left at once. A later scan saved tabs.json without alpha. One signal.'
    })

    await check(section, 'AC 11 and 15: a crash right after the closing record saves leaves the server running, and the reopen keeps the row with no signal', async () => {
      const delta = await stub('delta2')
      await hub.evaluate((_electron, rootD) => {
        const fs = process.getBuiltinModule('node:fs') as unknown as Record<string, (...args: unknown[]) => unknown>
        const real = fs.renameSync
        fs.renameSync = (from: unknown, to: unknown) => {
          real(from, to)
          const text = (fs.readFileSync as (path: unknown, encoding: string) => string)(to, 'utf8')
          if (String(to).endsWith('tabs.json') && text.includes('"closing"') && text.includes(rootD as string)) process.kill(process.pid, 'SIGKILL')
        }
      }, root('delta2'))
      await hub.planSheets(['action'])
      await chooseClose(hub, 'delta2').catch(() => {})
      await until('the app to exit', () => !hub.windowsAlive(), 15000)
      assert.ok(isAlive(delta.child.pid!))
      hub = await Hub.launch(home, userData)
      await prepare()
      await until('delta2 running', async () => (await hub.tab('delta2'))?.port === delta.port, 15000)
      await until('the record cleared', () => savedLifecycle(hub, root('delta2')) === null, 5000)
      await sleep(1500)
      assert.deepEqual(await hub.processCalls(), { signals: [], spawns: [] })
      return `the app exited with the closing record saved. Pid ${delta.child.pid} kept running. The reopened app kept the row, cleared the record, and sent nothing.`
    })

    await check(section, 'AC 11 and 15: a crash right after the Close signal, and right after the final save, both reopen without the row and with no signal', async () => {
      const results: string[] = []
      for (const point of ['signal', 'final save'] as const) {
        const name = point === 'signal' ? 'eps1' : 'eps2'
        const target = await stub(name)
        await hub.evaluate((_electron, [point, rootE]) => {
          if (point === 'signal') {
            const real = process.kill.bind(process)
            process.kill = ((pid: number, signal?: string | number) => {
              const result = real(pid, signal)
              if (signal === 'SIGTERM') real(process.pid, 'SIGKILL')
              return result
            }) as typeof process.kill
            return
          }
          const fs = process.getBuiltinModule('node:fs') as unknown as Record<string, (...args: unknown[]) => unknown>
          const real = fs.renameSync
          let closing = false
          fs.renameSync = (from: unknown, to: unknown) => {
            real(from, to)
            const text = (fs.readFileSync as (path: unknown, encoding: string) => string)(to, 'utf8')
            if (!String(to).endsWith('tabs.json')) return
            if (text.includes('"closing"')) closing = true
            else if (closing && !text.includes(rootE)) process.kill(process.pid, 'SIGKILL')
          }
        }, [point, root(name)] as const)
        await hub.planSheets(['action'])
        await chooseClose(hub, name).catch(() => {})
        await until('the app to exit', () => !hub.windowsAlive(), 15000)
        await until(`${name} to exit`, () => target.child.exitCode !== null, 10000)
        hub = await Hub.launch(home, userData)
        await prepare()
        await sleep(2500)
        assert.equal(await hub.tab(name), undefined)
        assert.equal(hub.savedTabs().some((tab) => tab.root === root(name)), false)
        assert.deepEqual(await hub.processCalls(), { signals: [], spawns: [] })
        results.push(`${point}: no row, no signal`)
      }
      return results.join('. ')
    })
  } finally {
    await hub.quit().catch(() => hub.forceStop())
    for (const started of stubs.values()) await started.stop().catch(() => {})
  }
}
