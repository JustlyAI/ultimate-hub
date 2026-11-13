import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CLONE, isAlive, listeningPorts, makeProject, processTree, projectHome, startScriptedModel, startUltimate, tempDir, until } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { settled, showProject } from './real.ts'

const section = 'add'
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const NODE = realpathSync(process.execPath)
const ENTRY = realpathSync(join(CLONE, 'bin/ultimate.ts'))

type Picked = { title?: string; buttonLabel?: string; properties?: string[] }

/** The next folder picker answers with `path`, or cancels for null. The real picker is a native sheet that checks cannot drive. */
const planPicker = (hub: Hub, path: string | null) =>
  hub.evaluate(({ dialog }, chosen) => {
    const holder = globalThis as unknown as { picked: Picked[] }
    holder.picked = []
    dialog.showOpenDialog = (async (_window: unknown, options: Picked) => {
      holder.picked.push(options)
      return chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] }
    }) as typeof dialog.showOpenDialog
  }, path)

const picked = (hub: Hub) => hub.evaluate(() => (globalThis as unknown as { picked: Picked[] }).picked, null)

async function chooseAddUltimate(hub: Hub) {
  await hub.planMenus(['Ultimate'])
  await hub.shell().locator('#add').click()
  await until('the picker', async () => (await picked(hub)).length === 1, 5000)
}

function supervisorOf(home: string, root: string): { pid: number; port: number } | null {
  try {
    const lock = JSON.parse(readFileSync(join(projectHome(home, root), 'ultimate.lock'), 'utf8')) as { pid: number; port: number }
    return isAlive(lock.pid) && listeningPorts([lock.pid]).includes(lock.port) ? lock : null
  } catch {
    return null
  }
}

/** Ends a supervisor of this run, and its children. The caller knows the PID from the lock of a temporary project. */
async function stopOurs(pid: number) {
  if (!isAlive(pid)) return
  const tree = processTree(pid)
  process.kill(pid, 'SIGTERM')
  await until(`supervisor ${pid} and its children to exit`, () => tree.every((child) => !isAlive(child)), 20000)
}

export async function runAddChecks(check: Check) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const model = await startScriptedModel()
  const runner = makeProject(projects, 'runner')
  mkdirSync(join(projects, 'clients'))
  const earlier = makeProject(join(projects, 'clients'), 'earlier')
  makeProject(join(projects, 'clients'), 'amber')
  const clients = join(projects, 'clients')
  const empty = tempDir('empty')
  mkdirSync(join(empty, 'notes'))
  const ours: number[] = []

  // Ultimate has run in `earlier` once, so its project folder exists, and it is not running now.
  const once_ = startUltimate(home, earlier, model.agentDir)
  await once_.port()
  await stopOurs(once_.child.pid!)
  const running = startUltimate(home, runner, model.agentDir)
  ours.push(running.child.pid!)
  await running.port()

  const hub = await Hub.launch(home, userData, { HOME: home, PATH: FINDER_PATH, PI_CODING_AGENT_DIR: model.agentDir })
  try {
    await hub.spyOnProcesses()
    await until('the runner row', async () => (await hub.labels()).join() === 'runner', 30000)

    await check(section, '+ > Ultimate opens the folder picker on the window, and Cancel adds nothing and returns focus to +', async () => {
      await planPicker(hub, null)
      await chooseAddUltimate(hub)
      const [options] = await picked(hub)
      assert.deepEqual(options, { title: 'Open project on this Mac', buttonLabel: 'Open in Hub', properties: ['openDirectory'] })
      await until('focus back on +', async () => (await hub.focusedInShell()) === 'add', 3000)
      assert.deepEqual(await hub.labels(), ['runner'])
      assert.deepEqual((await hub.processCalls()).spawns, [])
      return `picker ${JSON.stringify(options)}. Cancel left the rows as [runner], started nothing, and focus was on +.`
    })

    await check(section, 'a folder with no Ultimate, in it or in its folders, asks to start a new Ultimate, and Cancel adds nothing', async () => {
      await hub.planSheets(['hold'])
      await planPicker(hub, empty)
      await chooseAddUltimate(hub)
      const [sheet] = await until('the question', async () => ((await hub.sheetsShown()).length === 1 ? hub.sheetsShown() : null), 5000)
      await hub.screenshot(join(EVIDENCE, 'add-1-start-new.png'))
      await hub.releaseSheet('cancel')
      const [answered] = await until('the answer', async () => ((await hub.sheetsShown())[0].answer ? hub.sheetsShown() : null), 3000)
      assert.deepEqual({ ...sheet, answer: answered.answer }, {
        title: 'No Ultimate in this folder',
        text: 'Ultimate has not run in this folder or in a folder in it. Start a new Ultimate here?',
        path: empty,
        buttons: ['Cancel', 'Start Ultimate'],
        focused: 'sheet-cancel',
        answer: 'cancel',
      })
      assert.deepEqual(await hub.labels(), ['runner'])
      assert.deepEqual((await hub.processCalls()).spawns, [])
      return `question "${sheet.title}" with ${empty}. Cancel left no row and no start. Screenshot add-1-start-new.png`
    })

    let added: { pid: number; port: number } | null = null
    await check(section, 'a parent folder adds the first folder in it where Ultimate has run, selects it, and starts it with the launcher of the running Ultimate', async () => {
      await hub.planSheets([])
      await planPicker(hub, clients)
      await chooseAddUltimate(hub)
      await until('the earlier row', async () => (await hub.labels()).includes('earlier'), 5000)
      added = await until('earlier running', () => supervisorOf(home, earlier), 60000)
      ours.push(added.pid)
      const { spawns, signals } = await hub.processCalls()
      assert.equal(spawns.length, 1, JSON.stringify(spawns))
      assert.deepEqual({ file: spawns[0].file, args: spawns[0].args, pid: spawns[0].pid }, { file: NODE, args: [ENTRY, earlier, '--no-open'], pid: added.pid })
      assert.deepEqual(signals, [])
      assert.deepEqual(await hub.labels(), ['runner', 'earlier'], 'amber, where Ultimate never ran, is not added')
      const page = await showProject(hub, 'earlier', earlier)
      assert.equal(new URL(page.url()).port, String(added.port))
      await settled(home, earlier, page)
      assert.ok((await page.locator('body').innerText()).includes('earlier'), 'the page shows the project')
      const tab = hub.saved().tabs.find((saved) => saved.root === earlier)
      assert.deepEqual(tab, { root: earlier, name: null, groupId: null, lifecycle: null })
      await hub.screenshot(join(EVIDENCE, 'add-2-started.png'))
      return `chose ${clients}. Hub skipped amber, where Ultimate never ran, and found ${earlier}, spawned ${NODE} ${ENTRY} ${earlier} --no-open as pid ${added.pid}, and the selected page is on ${added.port}. Screenshot add-2-started.png`
    })

    await check(section, 'adding a running project again only selects it, with no second start', async () => {
      await hub.select('runner')
      await planPicker(hub, earlier)
      await chooseAddUltimate(hub)
      await until('earlier selected', async () => (await hub.topRows()).find(({ selected }) => selected)?.label === 'earlier', 5000)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal((await hub.processCalls()).spawns.length, 1)
      assert.deepEqual(supervisorOf(home, earlier), added)
      return `the second add selected earlier, and the only spawn is still pid ${added!.pid}.`
    })

    await check(section, 'Start Ultimate in a folder with no Ultimate starts a new one there, with the launcher of the running Ultimate', async () => {
      await hub.planSheets(['action'])
      await planPicker(hub, empty)
      await chooseAddUltimate(hub)
      await until('the empty row', async () => (await hub.labels()).includes(basename(empty)), 5000)
      const fresh = await until('the new Ultimate running', () => supervisorOf(home, empty), 60000)
      ours.push(fresh.pid)
      const shown = await hub.sheetsShown()
      assert.deepEqual(shown.map(({ title, answer }) => ({ title, answer })).at(-1), { title: 'No Ultimate in this folder', answer: 'action' })
      assert.equal(shown.length, 2, 'one question for this add, after the first check')
      const { spawns, signals } = await hub.processCalls()
      assert.equal(spawns.length, 2, JSON.stringify(spawns))
      assert.deepEqual({ file: spawns[1].file, args: spawns[1].args, pid: spawns[1].pid }, { file: NODE, args: [ENTRY, empty, '--no-open'], pid: fresh.pid })
      assert.deepEqual(signals, [])
      const page = await showProject(hub, basename(empty), empty)
      assert.equal(new URL(page.url()).port, String(fresh.port))
      await settled(home, empty, page)
      await hub.screenshot(join(EVIDENCE, 'add-3-started-new.png'))
      return `Start Ultimate spawned ${NODE} ${ENTRY} ${empty} --no-open as pid ${fresh.pid}, and the selected page is on ${fresh.port}. Screenshot add-3-started-new.png`
    })
  } finally {
    await hub.quit()
    const started = [earlier, empty].map((root) => supervisorOf(home, root)).filter((lock) => lock !== null)
    for (const pid of new Set([...ours, ...started.map(({ pid }) => pid)])) await stopOurs(pid)
    model.close()
  }
}
