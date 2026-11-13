import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanEnv, isAlive, projectHome, sleep, startStub, tempDir, until, writeLock, type Stub } from '../support/fixtures.ts'
import { BareHub } from '../support/bare.ts'
import type { Page } from 'playwright'
import { APP, Hub } from '../support/hub.ts'
import { SIDEBAR_WIDTH } from '../../src/shared/tabs.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

// One scan each second, plus time to read and render.
const NEXT_SCAN_MS = 2500

type World = { hub: Hub; home: string; projects: string }

async function withHub(run: (world: World) => Promise<string>): Promise<string> {
  const home = tempDir('home')
  const projects = tempDir('projects')
  const userData = tempDir('data')
  const hub = await Hub.launch(home, userData)
  try {
    return await run({ hub, home, projects })
  } finally {
    await hub.quit()
  }
}

const hits = async (stub: Stub) => Number(await (await fetch(`http://127.0.0.1:${stub.port}/hits`)).text())

const rootOf = async (hub: Hub) =>
  (await hub.shownPage()).evaluate(() => document.body.dataset.root)

async function appear(hub: Hub, label: string, timeout = NEXT_SCAN_MS) {
  return until(`tab ${label}`, async () => {
    const tab = await hub.tab(label)
    return tab && !tab.dimmed ? tab : null
  }, timeout)
}

export async function runRuleChecks(check: Check) {
  const section = 'rule'

  await check(section, 'no instances shows that no Ultimate is running', () =>
    withHub(async ({ hub }) => {
      const message = await until('the message', () => hub.message())
      assert.equal(message, 'No Ultimate running')
      assert.deepEqual(await hub.topRows(), [])
      return `message is "${message}", with 0 tabs, and ~/.ultimate does not exist in this HOME`
    }),
  )

  await check(section, 'a new instance appears within about two seconds', () =>
    withHub(async ({ hub, home, projects }) => {
      await until('first scan', () => hub.message())
      const started = Date.now()
      const stub = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      const elapsed = Date.now() - started
      await stub.stop()
      assert.ok(elapsed < NEXT_SCAN_MS)
      return `tab visible ${elapsed} ms after the lock was written`
    }),
  )

  await check(section, 'a tab loads on first select and then stays loaded', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'alpha')
      await appear(hub, 'beta')
      await until('alpha loads', async () => (await hits(a)) === 1)
      assert.equal(await hits(b), 0, 'beta must not load before select')
      assert.equal((await hub.shown()).pages, 1)
      await hub.select('beta')
      await until('beta loads', async () => (await hits(b)) === 1)
      await hub.select('alpha')
      await hub.select('beta')
      await sleep(300)
      assert.equal(await hits(a), 1)
      assert.equal(await hits(b), 1)
      assert.equal((await hub.shown()).pages, 2)
      await a.stop()
      await b.stop()
      return 'server hits before select: beta 0. After select, and after switching back and forth: alpha 1, beta 1. 2 views.'
    }),
  )

  await check(section, 'selection gives keyboard focus to the page', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta')
      await hub.select('beta')
      const focused = await until('focus', async () => {
        const url = await hub.focusedUrl()
        return url?.includes(String(b.port)) ? url : null
      })
      await a.stop()
      await b.stop()
      return `focused view is ${focused}`
    }),
  )

  await check(section, 'Ctrl+Tab and Ctrl+Shift+Tab move between tabs, from a page and from the sidebar', () =>
    withHub(async ({ hub, home, projects }) => {
      const stubs = await Promise.all(['alpha', 'beta', 'gamma'].map((name) => startStub(home, join(projects, name))))
      await appear(hub, 'gamma')
      const selected = async () => (await hub.topRows()).find((tab) => tab.selected)?.label
      await until('alpha selected', async () => (await selected()) === 'alpha' && (await hub.focusedUrl())?.startsWith('http'))
      const seen: string[] = []
      for (const [modifiers, expected] of [
        [['control'], 'beta'],
        [['control'], 'gamma'],
        [['control'], 'alpha'],
        [['control', 'shift'], 'gamma'],
      ] as [string[], string][]) {
        await hub.key('Tab', modifiers)
        await until(`${expected} selected`, async () => (await selected()) === expected)
        await until(`${expected} focused`, async () => (await hub.focusedUrl())?.startsWith('http'))
        const page = await hub.shownPage()
        await page.waitForFunction((root) => document.body?.dataset.root === root, join(projects, expected))
        seen.push(expected)
      }
      await hub.evaluate(({ BaseWindow }) => {
        ;(BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.focus()
      }, null)
      const from = await hub.key('Tab', ['control'])
      assert.ok(from.startsWith('file:'), `key went to ${from}`)
      await until('alpha selected from the sidebar', async () => (await selected()) === 'alpha')
      const pageKeys = await (await hub.shownPage()).evaluate(() => (window as unknown as { keys: string[] }).keys)
      assert.ok(!pageKeys.includes('Tab'), `the page saw ${pageKeys.join()}`)
      await hub.select('beta')
      await until('beta focused', async () => (await hub.focusedUrl())?.includes(String(stubs[1].port)))
      await hub.key('Tab')
      const plainTab = await until('plain Tab', async () => {
        const keys = await (await hub.shownPage()).evaluate(() => (window as unknown as { keys: string[] }).keys)
        return keys.includes('Tab') ? keys : null
      })
      assert.equal((await hub.topRows()).find((tab) => tab.selected)?.label, 'beta')
      for (const stub of stubs) await stub.stop()
      return `from a page: ${seen.join(', ')}. From the sidebar view: alpha. The page never saw Ctrl+Tab. Plain Tab reached the page (${plainTab.join()}) and did not switch.`
    }),
  )

  await check(section, '⌘K and mod+digits reach the page and do not move the app', () =>
    withHub(async ({ hub, home, projects }) => {
      const stubs = await Promise.all(['alpha', 'beta'].map((name) => startStub(home, join(projects, name))))
      await appear(hub, 'beta')
      await until('focus', async () => (await hub.focusedUrl())?.startsWith('http'))
      const keys = ['K', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
      for (const key of keys) await hub.key(key, ['meta'])
      const seen = await until('all keys', async () => {
        const logged = await (await hub.shownPage()).evaluate(() => (window as unknown as { keys: string[] }).keys)
        return logged.length >= keys.length ? logged : null
      })
      assert.deepEqual(seen, keys.map((key) => `Meta+${key.toLowerCase()}`))
      assert.equal((await hub.topRows()).find((tab) => tab.selected)?.label, 'alpha')
      for (const stub of stubs) await stub.stop()
      return `the page saw ${seen.join(' ')}, and the selected tab did not change`
    }),
  )

  await check(section, 'a stopped named tab dims, keeps its name, and shows not running when selected', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta')
      await hub.rename('beta', 'Website')
      await appear(hub, 'Website')
      await hub.select('alpha')
      const stopped = Date.now()
      await b.stop()
      const tab = await until('dim', async () => {
        const row = await hub.tab('Website')
        return row?.dimmed ? row : null
      }, NEXT_SCAN_MS)
      const elapsed = Date.now() - stopped
      assert.equal(tab.port, null)
      assert.equal(tab.selected, false)
      await hub.select('Website')
      await until('message', async () => (await hub.message()) === 'Website is not running')
      assert.deepEqual((await hub.shown()).visible, [])
      await a.stop()
      return `dimmed ${elapsed} ms after stop. Selected: "${await hub.message()}", no visible page view.`
    }),
  )

  await check(section, 'a stopped unnamed tab that is not selected leaves the list', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta')
      await b.stop()
      await until('leave', async () => (await hub.labels()).join() === 'alpha', NEXT_SCAN_MS)
      await a.stop()
      return 'list is [alpha] after beta stopped'
    }),
  )

  await check(section, 'a stopped unnamed selected tab stays dimmed until another tab is selected', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta')
      await hub.select('beta')
      await b.stop()
      const row = await until('dim', async () => {
        const tab = await hub.tab('beta')
        return tab?.dimmed ? tab : null
      }, NEXT_SCAN_MS)
      assert.equal(row.selected, true)
      assert.equal(await hub.message(), 'beta is not running')
      await hub.select('alpha')
      await until('leave', async () => (await hub.labels()).join() === 'alpha')
      await a.stop()
      return 'beta stayed dimmed and selected with the message, then left the list when alpha was selected'
    }),
  )

  await check(section, 'a selected dimmed tab becomes live when the project returns', () =>
    withHub(async ({ hub, home, projects }) => {
      const root = join(projects, 'alpha')
      const first = await startStub(home, root)
      await appear(hub, 'alpha')
      await first.stop()
      await until('dim', async () => (await hub.tab('alpha'))?.dimmed, NEXT_SCAN_MS)
      const second = await startStub(home, root)
      await until('page', async () => (await hub.shown()).visible[0]?.url.includes(String(second.port)), NEXT_SCAN_MS)
      assert.equal(await until('root', () => rootOf(hub)), root)
      await second.stop()
      return `page shows ${root} again on port ${second.port}`
    }),
  )

  await check(section, 'removing a dimmed tab deletes only its saved entry, and it returns as new', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const root = join(projects, 'beta')
      const b = await startStub(home, root)
      await appear(hub, 'beta')
      await hub.rename('beta', 'Website')
      await appear(hub, 'Website')
      await hub.planMenus([null])
      await hub.topRow('alpha').locator('.row-menu').click()
      await until('the row menu', async () => (await hub.menusShown()).length === 1)
      assert.deepEqual((await hub.menusShown())[0].items.map(({ label }) => label), ['Rename', 'Close Ultimate…'], 'a live tab offers Close, not Remove')
      await b.stop()
      await until('dim', async () => (await hub.tab('Website'))?.dimmed)
      const folder = projectHome(home, root)
      await hub.removeRow('Website')
      await until('gone', async () => (await hub.labels()).join() === 'alpha')
      assert.deepEqual(hub.savedTabs().map(({ root }) => root), [join(projects, 'alpha')])
      assert.ok(existsSync(join(folder, 'ultimate.lock')), "Ultimate's files stay")
      const c = await startStub(home, join(projects, 'gamma'))
      await appear(hub, 'gamma')
      const again = await startStub(home, root)
      await appear(hub, 'beta')
      assert.deepEqual(await hub.labels(), ['alpha', 'gamma', 'beta'])
      for (const stub of [a, c, again]) await stub.stop()
      return "entry removed from tabs.json, Ultimate's lock file still there, and the project returned last as \"beta\""
    }),
  )

  await check(section, 'drag reorder persists across a restart, and a hidden project goes back to its place', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const userData = tempDir('data')
    const [a, b, c] = await Promise.all(['alpha', 'beta', 'gamma'].map((name) => startStub(home, join(projects, name))))
    let hub = await Hub.launch(home, userData)
    await appear(hub, 'gamma')
    const order = await hub.labels()
    assert.equal(order.length, 3)
    const [first, , last] = order
    await hub.drag(last, first, 'top')
    await until('moved', async () => (await hub.labels())[0] === last)
    const dragged = await hub.labels()
    assert.deepEqual(dragged, [last, first, order[1]])
    assert.deepEqual(hub.savedTabs().map(({ root }) => String(root).split('/').pop()), dragged, 'array order is the order')
    assert.ok(hub.savedTabs().every((tab) => Object.keys(tab).join() === 'root,name,groupId,lifecycle'), 'each saved tab holds only root, name, groupId, and lifecycle')
    const middle = dragged[1]
    const middleStub = [a, b, c].find(({ root }) => root.endsWith(middle))!
    await hub.select(dragged[0])
    await middleStub.stop()
    await until('hidden', async () => !(await hub.labels()).includes(middle), NEXT_SCAN_MS)
    await hub.quit()
    hub = await Hub.launch(home, userData)
    await appear(hub, dragged[2])
    assert.deepEqual(await hub.labels(), [dragged[0], dragged[2]])
    const back = await startStub(home, middleStub.root)
    await appear(hub, middle)
    assert.deepEqual(await hub.labels(), dragged)
    const d = await startStub(home, join(projects, 'delta'))
    await appear(hub, 'delta')
    assert.deepEqual(await hub.labels(), [...dragged, 'delta'])
    await hub.drag(dragged[0], dragged[2], 'bottom')
    await until('moved down', async () => (await hub.labels())[2] === dragged[0])
    const final = await hub.labels()
    await hub.quit()
    hub = await Hub.launch(home, userData)
    await appear(hub, 'delta')
    assert.deepEqual(await hub.labels(), final)
    await hub.quit()
    for (const stub of [a, b, c, back, d]) await stub.stop()
    return `drag gave ${dragged.join(', ')}. ${middle} hid, the app restarted, and ${middle} returned to the middle. New project went last. Second drag gave ${final.join(', ')}, kept after restart.`
  })

  await check(section, 'a project that returns on a new port keeps its name and position, and the tab reloads there', () =>
    withHub(async ({ hub, home, projects }) => {
      const root = join(projects, 'alpha')
      const first = await startStub(home, root)
      const other = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta')
      await hub.rename('alpha', 'Website')
      await appear(hub, 'Website')
      await hub.select('Website')
      await first.stop()
      // No sleep: this restart can land between two scans, so the tab can go straight from one port to the next.
      const second = await startStub(home, root)
      assert.notEqual(second.port, first.port)
      await until('new address', async () => (await hub.shown()).visible[0]?.url.includes(String(second.port)), NEXT_SCAN_MS)
      assert.equal(await until('root', () => rootOf(hub)), root)
      assert.deepEqual(await hub.labels(), ['Website', 'beta'])
      assert.equal((await hub.tab('Website'))!.port, second.port)
      await second.stop()
      await other.stop()
      return `port ${first.port} to ${second.port}, name and position kept, page names ${root}`
    }),
  )

  await check(section, 'a port taken over by another project: each tab follows its root, and storage does not cross', () =>
    withHub(async ({ hub, home, projects }) => {
      const rootA = join(projects, 'alpha')
      const rootB = join(projects, 'beta')
      const a = await startStub(home, rootA)
      await appear(hub, 'alpha')
      await hub.rename('alpha', 'Website')
      await appear(hub, 'Website')
      const pageA = await until('page', () => hub.shownPage())
      await pageA.evaluate(() => localStorage.setItem('draft', 'from alpha'))
      await a.stop()
      const started = Date.now()
      const b = await startStub(home, rootB, a.port)
      const row = await until('Website dims', async () => {
        const tab = await hub.tab('Website')
        return tab?.dimmed ? tab : null
      }, NEXT_SCAN_MS)
      const corrected = Date.now() - started
      assert.equal(row.port, null)
      assert.deepEqual((await hub.shown()).visible, [], 'no view shows the other project under the alpha tab')
      await appear(hub, 'beta')
      assert.equal((await hub.tab('beta'))!.port, a.port)
      await hub.select('beta')
      await until('beta page', async () => (await rootOf(hub)) === rootB)
      const leaked = await (await hub.shownPage()).evaluate(() => localStorage.getItem('draft'))
      assert.equal(leaked, null, 'storage must not cross between projects on one port')
      await b.stop()
      const back = await startStub(home, rootA, a.port)
      await hub.select('Website')
      await until('alpha page', async () => (await rootOf(hub)) === rootA)
      const kept = await (await hub.shownPage()).evaluate(() => localStorage.getItem('draft'))
      assert.equal(kept, 'from alpha')
      const control = await hub.evaluate(async ({ session, WebContentsView }, url) => {
        const shared = session.fromPartition('shared-control')
        const read = async (write: boolean) => {
          const view = new WebContentsView({ webPreferences: { session: shared } })
          await view.webContents.loadURL(url)
          const value = await view.webContents.executeJavaScript(
            write ? "localStorage.setItem('draft','leak'); 'written'" : "localStorage.getItem('draft')",
          )
          view.webContents.close()
          return value
        }
        await read(true)
        return read(false)
      }, `http://127.0.0.1:${back.port}/`)
      await back.stop()
      assert.equal(control, 'leak', 'control: a shared session does leak')
      return `tab corrected ${corrected} ms after takeover. Beta on the same port read draft=null. Alpha back on the port read draft="${kept}". Control with one shared session read "${control}", so per-project sessions are needed.`
    }),
  )

  await check(section, 'a lock that names another project\'s port is not proof, even when the port answers', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const rootB = join(projects, 'beta')
      const b = await startStub(home, rootB)
      await appear(hub, 'beta')
      await hub.select('alpha')
      await hub.rename('beta', 'Named')
      await appear(hub, 'Named')
      writeLock(home, rootB, { pid: b.child.pid!, port: a.port })
      await until('dim', async () => (await hub.tab('Named'))?.dimmed, NEXT_SCAN_MS)
      assert.equal((await fetch(`http://127.0.0.1:${a.port}/hits`)).ok, true, 'the port answers')
      assert.equal((await hub.tab('alpha'))!.port, a.port)
      await hub.select('Named')
      await until('message', async () => (await hub.message()) === 'Named is not running')
      assert.deepEqual((await hub.shown()).visible, [])
      writeLock(home, rootB, { pid: b.child.pid!, port: b.port })
      await until('live', async () => (await hub.tab('Named'))?.port === b.port, NEXT_SCAN_MS)
      await a.stop()
      await b.stop()
      return 'lock with its own live pid and alpha\'s answering port gave a dimmed tab. Correcting the lock made it live on its own port.'
    }),
  )

  await check(section, 'other false locks: dead pid, a live pid with no socket, and a second lock that names a running project', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const dead = await startStub(home, join(projects, 'beta'))
      await dead.stop('SIGKILL')
      const deadPid = dead.child.pid!
      assert.equal(isAlive(deadPid), false)
      writeLock(home, join(projects, 'gamma'), { pid: process.pid, port: a.port })
      writeLock(home, join(projects, 'delta'), { pid: a.child.pid!, port: a.port, project: join(projects, 'alpha') })
      await appear(hub, 'alpha')
      await sleep(NEXT_SCAN_MS)
      assert.deepEqual(await hub.labels(), ['alpha'])
      await a.stop()
      return 'a stale lock after SIGKILL and a lock with the live test process pid gave no tab, and a second lock that names alpha added no second tab'
    }),
  )

  for (const contents of [
    'not json',
    '{"pid":"x","port":1}',
    '{"pid":1,"port":1}',
    '{"pid":1,"port":1,"project":"relative/path"}',
  ]) {
    await check(section, `corrupt ultimate.lock (${contents}) means not running, one log line, no crash, and recovery`, () =>
      withHub(async ({ hub, home, projects }) => {
        const a = await startStub(home, join(projects, 'alpha'))
        const root = join(projects, 'beta')
        const b = await startStub(home, root)
        await appear(hub, 'beta')
        await hub.rename('beta', 'Named')
        await appear(hub, 'Named')
        await hub.select('Named')
        await until('page', async () => (await hub.shown()).visible[0]?.url.includes(String(b.port)))
        const path = join(projectHome(home, root), 'ultimate.lock')
        const good = readFileSync(path, 'utf8')
        writeFileSync(path, contents)
        await until('dim', async () => (await hub.tab('Named'))?.dimmed, NEXT_SCAN_MS)
        assert.equal(await hub.message(), 'Named is not running')
        assert.deepEqual((await hub.shown()).visible, [])
        await sleep(2200)
        const lines = hub.log().split('\n').filter((line) => line.includes(path))
        assert.equal(lines.length, 1, `log lines: ${lines.length}`)
        assert.equal((await hub.tab('alpha'))?.port, a.port)
        assert.ok(hub.windowsAlive())
        writeFileSync(path, good)
        await until('live', async () => (await hub.tab('Named'))?.port === b.port, NEXT_SCAN_MS)
        await a.stop()
        await b.stop()
        return `log: ${lines[0].replace(home, '$HOME').slice(0, 170)}`
      }),
    )
  }

  await check(section, 'project.json is not read: a corrupt one changes nothing, and one with no lock gives no tab', () =>
    withHub(async ({ hub, home, projects }) => {
      const root = join(projects, 'alpha')
      const a = await startStub(home, root)
      await appear(hub, 'alpha')
      writeFileSync(join(projectHome(home, root), 'project.json'), 'not json')
      const orphan = projectHome(home, join(projects, 'beta'))
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, 'project.json'), JSON.stringify({ root: join(projects, 'beta'), name: 'beta', openedAt: 1 }))
      await sleep(NEXT_SCAN_MS)
      assert.equal((await hub.tab('alpha'))?.port, a.port)
      assert.deepEqual(await hub.labels(), ['alpha'])
      assert.ok(!hub.log().includes('project.json'))
      await a.stop()
      return 'alpha stayed live with a corrupt project.json, no log line named it, and a project with only project.json gave no tab'
    }),
  )

  const loadedPair = async ({ hub, home, projects }: World) => {
    const stubs = await Promise.all(['alpha', 'beta'].map((name) => startStub(home, join(projects, name))))
    await appear(hub, 'beta')
    await hub.select('beta')
    await until('beta loads', async () => (await hits(stubs[1])) === 1)
    await hub.select('alpha')
    await until('alpha loads', async () => (await hits(stubs[0])) === 1)
    const pageIds = () =>
      hub.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]).map((view) => view.webContents.id), null)
    const ids = await pageIds()
    assert.equal(ids.length, 2)
    /** Fails if a tab dims, a view closes, or a page reloads, at any moment until `done`. */
    const holdsUntil = async (done: () => Promise<boolean>) => {
      while (!(await done())) {
        assert.deepEqual((await hub.topRows()).map(({ port }) => port), stubs.map(({ port }) => port), 'tabs stay live')
        assert.deepEqual(await pageIds(), ids, 'views stay open')
        await sleep(25)
      }
      assert.deepEqual((await Promise.all(stubs.map(hits))), [1, 1], 'pages do not reload')
    }
    return { stubs, ids, pageIds, holdsUntil }
  }
  /** Long enough for one more whole scan. */
  const nextScanPassed = () => {
    const deadline = Date.now() + 1500
    return async () => Date.now() > deadline
  }

  await check(section, 'one failed lsof keeps every loaded page, for a bad exit code and for exit 1 with stderr', () =>
    withHub(async (world) => {
      const { hub } = world
      const { stubs, ids, holdsUntil } = await loadedPair(world)
      await hub.injectLsof({ count: 1, code: 2 })
      await holdsUntil(async () => (await hub.lsofFailuresSeen()) === 1)
      await holdsUntil(nextScanPassed())
      await hub.injectLsof({ count: 1, code: 1, stderr: 'lsof: injected' })
      await holdsUntil(async () => (await hub.lsofFailuresSeen()) === 2)
      await holdsUntil(nextScanPassed())
      const line = hub.log().split('\n').find((text) => text.includes('lsof:'))
      assert.ok(line, 'the failure is logged')
      for (const stub of stubs) await stub.stop()
      return `tabs, view ids ${ids.join(' and ')}, and server hits did not change, sampled every 25 ms through 2 separate failures. Log: ${line.slice(0, 100)}`
    }),
  )

  await check(section, 'two failed scans in a row keep the pages, a good scan resets the count, and a third in a row empties the list', () =>
    withHub(async (world) => {
      const { hub } = world
      const { stubs, pageIds, holdsUntil } = await loadedPair(world)
      await hub.injectLsof({ count: 2 })
      await holdsUntil(async () => (await hub.lsofFailuresSeen()) === 2)
      await holdsUntil(nextScanPassed())
      await hub.injectLsof({ count: 2 })
      await holdsUntil(async () => (await hub.lsofFailuresSeen()) === 4)
      await holdsUntil(nextScanPassed())
      await hub.injectLsof({ count: 3 })
      await holdsUntil(async () => (await hub.lsofFailuresSeen()) === 6)
      await until('the third failure to take effect', async () => (await hub.lsofFailuresSeen()) === 7 && (await hub.tab('alpha'))?.dimmed, NEXT_SCAN_MS)
      assert.equal(await hub.message(), 'alpha is not running')
      assert.deepEqual(await hub.labels(), ['alpha'], 'the unnamed tab that is not selected left')
      assert.deepEqual(await pageIds(), [])
      await until('recovery', async () => (await hub.topRows()).filter(({ port }) => port !== null).length === 2, NEXT_SCAN_MS)
      await until('the page again', async () => (await hits(stubs[0])) === 2, NEXT_SCAN_MS)
      for (const stub of stubs) await stub.stop()
      return 'after 2 failures, a good scan, and 2 more failures, nothing changed. The third failure in a row closed the views. The next good scan brought the tabs back and reloaded the selected page.'
    }),
  )

  await check(section, 'lsof exit 1 with empty stderr means that nothing listens, at once', () =>
    withHub(async (world) => {
      const { hub } = world
      const { stubs } = await loadedPair(world)
      const before = Date.now()
      await hub.injectLsof({ count: 1, code: 1, stderr: '' })
      await until('dim', async () => (await hub.tab('alpha'))?.dimmed, NEXT_SCAN_MS)
      const elapsed = Date.now() - before
      assert.equal(await hub.lsofFailuresSeen(), 1)
      assert.ok(!hub.log().includes('lsof:'), 'not logged as a failure')
      await until('recovery', async () => (await hub.topRows()).filter(({ port }) => port !== null).length === 2, NEXT_SCAN_MS)
      for (const stub of stubs) await stub.stop()
      return `one such result dimmed the selected tab after ${elapsed} ms, with no failure in the log. The next real scan brought it back.`
    }),
  )

  await check(section, 'a hung lsof times out, keeps the pages, and scans go on', () =>
    withHub(async (world) => {
      const { hub, home, projects } = world
      const { stubs, holdsUntil } = await loadedPair(world)
      const started = Date.now()
      await hub.injectLsof({ count: 1, hang: true })
      await holdsUntil(async () => hub.log().includes('lsof:'))
      const timedOut = Date.now() - started
      const later = await startStub(home, join(projects, 'gamma'))
      await appear(hub, 'gamma', NEXT_SCAN_MS)
      for (const stub of [...stubs, later]) await stub.stop()
      return `the hung call failed after ${timedOut} ms with the pages intact, and a new project appeared afterward`
    }),
  )

  await check(section, 'with a read-only user data folder, scans go on, the UI follows, nothing crashes, and saving resumes', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const userData = tempDir('data')
    const hub = await Hub.launch(home, userData)
    const a = await startStub(home, join(projects, 'alpha'))
    await appear(hub, 'alpha')
    await until('alpha saved', () => existsSync(join(userData, 'tabs.json')))
    writeFileSync(join(userData, 'hub.log'), 'before\n')
    chmodSync(join(userData, 'hub.log'), 0o444)
    chmodSync(userData, 0o555)
    try {
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'beta', NEXT_SCAN_MS)
      await hub.rename('beta', 'Named')
      await appear(hub, 'Named', NEXT_SCAN_MS)
      writeFileSync(join(projectHome(home, a.root), 'ultimate.lock'), 'not json')
      await until('a corrupt lock with no way to log it to stop alpha', async () => !(await hub.labels()).includes('alpha'), NEXT_SCAN_MS)
      writeLock(home, a.root, { pid: a.child.pid!, port: a.port })
      await appear(hub, 'alpha', NEXT_SCAN_MS)
      await b.stop()
      await until('a stopped project to dim', async () => (await hub.tab('Named'))?.dimmed, NEXT_SCAN_MS)
      await a.stop()
      const moved = await startStub(home, a.root)
      await until('the new port to show', async () => (await hub.tab('alpha'))?.port === moved.port, NEXT_SCAN_MS)
      await until('the page at the new port', async () => (await hub.shown()).visible[0]?.url.includes(String(moved.port)) || (await hub.topRows()).find((tab) => tab.selected)?.label !== 'alpha', NEXT_SCAN_MS)
      assert.ok(hub.windowsAlive())
      chmodSync(userData, 0o755)
      chmodSync(join(userData, 'hub.log'), 0o644)
      await until('saving to resume', () => hub.savedTabs().some(({ name }) => name === 'Named'), NEXT_SCAN_MS)
      await moved.stop()
      return 'with the folder and hub.log read-only: a new project appeared, a rename showed, a corrupt lock took its unnamed tab out of the list, a stopped project dimmed, and a new port showed. When the folder was writable again, tabs.json got the name.'
    } finally {
      chmodSync(userData, 0o755)
      chmodSync(join(userData, 'hub.log'), 0o644)
      await Promise.race([hub.quit(), sleep(5000)]).catch(() => {})
      hub.forceStop()
    }
  })

  await check(section, 'an unexpected error during a scan is logged, and scans and the sidebar go on', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await hub.evaluate(({ BaseWindow }) => {
        const { webContents } = BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView
        const send = webContents.send
        webContents.send = function (this: Electron.WebContents, ...args: Parameters<typeof send>) {
          webContents.send = send
          throw new Error('injected scan failure')
        } as typeof send
      }, null)
      const b = await startStub(home, join(projects, 'beta'))
      await until('the error in the log', () => hub.log().includes('injected scan failure'), NEXT_SCAN_MS)
      await appear(hub, 'beta', NEXT_SCAN_MS)
      await b.stop()
      await until('beta to leave', async () => (await hub.labels()).join() === 'alpha', NEXT_SCAN_MS)
      await a.stop()
      return 'one thrown error reached hub.log. The next scans showed the new tab, then removed it when it stopped.'
    }),
  )

  await check(section, 'a corrupt lock at launch and a corrupt tabs.json do not stop the app', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const userData = tempDir('data')
    const a = await startStub(home, join(projects, 'alpha'))
    const b = await startStub(home, join(projects, 'beta'))
    writeFileSync(join(projectHome(home, b.root), 'ultimate.lock'), '{{{')
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'tabs.json'), '[{"bad":true}]')
    const hub = await Hub.launch(home, userData)
    await appear(hub, 'alpha')
    await sleep(1500)
    assert.deepEqual(await hub.labels(), ['alpha'])
    const log = hub.log()
    assert.ok(log.includes('tabs.json'))
    assert.ok(log.includes('ultimate.lock'))
    await hub.quit()
    await a.stop()
    await b.stop()
    return 'app listed only alpha, and hub.log names tabs.json and the bad lock'
  })

  await check(section, 'no view ever shows a browser error page', () =>
    withHub(async ({ hub, home, projects }) => {
      const root = join(projects, 'alpha')
      const a = await startStub(home, root)
      const dropping = await startStub(home, join(projects, 'beta'), 0, 'drop')
      await appear(hub, 'beta')
      await until('alpha page', () => hub.shownPage())
      const urls = new Set<string>()
      const watch = async (ms: number) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          for (const view of (await hub.shown()).visible) urls.add(view.url)
          await sleep(25)
        }
      }
      await hub.select('beta')
      await watch(3000)
      assert.equal((await hub.tab('beta'))!.dimmed, false, 'a socket owner with a failing page stays live')
      await dropping.stop()
      const fixed = await startStub(home, dropping.root, dropping.port)
      await until('recovery', async () => (await hits(fixed)) >= 1, 4000)
      await until('recovered root', async () => (await rootOf(hub)) === dropping.root)
      await hub.select('alpha')
      await sleep(200)
      const reloadRace = (await hub.shownPage()).reload().catch(() => {})
      await a.stop()
      await reloadRace
      await watch(3000)
      await fixed.stop()
      const errors = [...urls].filter((url) => !url.startsWith('http://127.0.0.1') && url !== '')
      assert.deepEqual(errors, [])
      return `sampled the visible view every 25 ms over a server that drops requests, its recovery, and a server stopping during reload. Addresses seen: ${[...urls].join(', ')}`
    }),
  )

  await check(section, 'a crashed page opens again at the next scan', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await until('load', async () => (await hits(a)) === 1)
      await until('alpha has focus', async () => (await hub.focusedUrl())?.startsWith('http'))
      const before = (await hub.shown()).visible[0].id
      await hub.evaluate(({ BaseWindow }) => {
        const [view] = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
        view.webContents.forcefullyCrashRenderer()
      }, null)
      await until('reopen', async () => (await hits(a)) === 2, NEXT_SCAN_MS + 1000)
      const after = (await hub.shown()).visible[0].id
      assert.notEqual(after, before)
      const focused = await until('the new view has focus', () =>
        hub.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null, null).then((id) => (id === after ? id : null)),
      )
      await a.stop()
      return `view ${before} crashed with focus, view ${focused} loaded the page again and got focus`
    }),
  )

  await check(section, 'when the selected project stops, Ctrl+Tab still moves to the next tab', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const a = await startStub(home, join(projects, 'alpha'))
    const b = await startStub(home, join(projects, 'beta'))
    const hub = await BareHub.launch(home, tempDir('data'))
    try {
      await until('two tabs', async () => (await hub.topRows()).length === 2)
      await until('alpha has focus', () =>
        hub.main(({ webContents }) => webContents.getFocusedWebContents()?.getURL().startsWith('http')),
      )
      await a.stop()
      await until('alpha dims', async () => (await hub.topRows()).find(({ label }) => label === 'alpha')?.dimmed)
      const target = await until('a view with focus', () =>
        hub.main(({ webContents }) => webContents.getFocusedWebContents()?.getURL()),
      )
      await hub.switchTab()
      await until('beta selected', async () => (await hub.topRows()).find(({ selected }) => selected)?.label === 'beta')
      return `after the stop, focus was on ${target.split('/').pop()}, and Ctrl+Tab selected beta`
    } finally {
      await hub.quit()
      await b.stop()
    }
  })

  await check(section, 'a scan does not take focus from the app in front', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const a = await startStub(home, join(projects, 'alpha'))
    const hub = await BareHub.launch(home, tempDir('data'))
    const front = await BareHub.launch(tempDir('home'), tempDir('data'))
    const windowFocused = (app: BareHub) => app.main(({ BaseWindow }) => BaseWindow.getAllWindows()[0].isFocused())
    const assertFrontKeepsFocus = async (when: string) => {
      await sleep(1000)
      assert.equal(await windowFocused(hub), false, `the hub took focus ${when}`)
      assert.equal(await windowFocused(front), true, `the other app lost focus ${when}`)
    }
    try {
      await until('alpha loads', () =>
        hub.main(({ BaseWindow }) => {
          const [, view] = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
          return view?.webContents.getURL().startsWith('http')
        }),
      )
      await front.main(({ app }) => app.focus({ steal: true }))
      await until('the other app is in front', () => windowFocused(front), 3000)
      await a.stop()
      await until('alpha dims', async () => (await hub.topRows())[0]?.dimmed)
      await assertFrontKeepsFocus('when the selected project stopped')
      const again = await startStub(home, a.root)
      await until('alpha returns', async () => !(await hub.topRows())[0]?.dimmed)
      await assertFrontKeepsFocus('when the selected project returned')
      await again.stop()
      return 'the other app kept focus through a stop and a return of the selected project'
    } finally {
      await front.quit()
      await hub.quit()
    }
  })

  await check(section, 'a second launch on the same user data exits, and the first keeps every name', async () => {
    const home = tempDir('home')
    const projects = tempDir('projects')
    const userData = tempDir('data')
    const a = await startStub(home, join(projects, 'alpha'))
    const b = await startStub(home, join(projects, 'beta'))
    const hub = await Hub.launch(home, userData)
    try {
      await appear(hub, 'alpha')
      await appear(hub, 'beta')
      await hub.rename('alpha', 'Kept')
      await until('the name is saved', () => hub.savedTabs().some(({ name }) => name === 'Kept'))
      await hub.evaluate(({ app }) => app.hide(), null)
      await until('the app hides', () => hub.evaluate(({ app }) => app.isHidden(), null))
      const second = spawn(APP, [`--user-data-dir=${userData}`], { env: cleanEnv(home), stdio: 'ignore' })
      const exited = once(second, 'exit')
      const code = await Promise.race([exited.then(([code]) => code), sleep(5000).then(() => 'still running')])
      if (code === 'still running') second.kill('SIGKILL')
      assert.equal(code, 0, 'the second process must exit')
      await until('the first window comes to the front', () => hub.evaluate(({ app }) => !app.isHidden(), null), 3000)
      await hub.rename('beta', 'AlsoKept')
      await until('both names are saved', () => hub.savedTabs().filter(({ name }) => name).length === 2)
      await sleep(NEXT_SCAN_MS)
      const names = hub.savedTabs().map(({ name }) => name)
      assert.deepEqual(names, ['Kept', 'AlsoKept'])
      assert.ok(hub.windowsAlive())
      return `second process exited with code ${code}. tabs.json names: ${names.join(', ')}`
    } finally {
      await hub.quit()
      await a.stop()
      await b.stop()
    }
  })

  await check(section, 'a redirect to another project stays out of the tab', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'alpha')
      await hub.spyOnExternal()
      const page = await until('page', () => hub.shownPage())
      const target = `http://127.0.0.1:${b.port}/`
      await page.evaluate((to) => {
        setTimeout(() => (location.href = `/redirect?to=${encodeURIComponent(to)}`), 0)
      }, target)
      await until('the browser gets the address', async () => (await hub.externals()).includes(target))
      await sleep(NEXT_SCAN_MS)
      assert.equal(await rootOf(hub), a.root)
      assert.equal((await hub.tab('alpha'))?.selected, true)
      await a.stop()
      await b.stop()
      return `alpha's tab still shows alpha, and ${target} went to the default browser`
    }),
  )

  await check(section, 'a same-site redirect stays in the tab, and a redirect in an iframe is not blocked', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      await appear(hub, 'alpha')
      await hub.spyOnExternal()
      const page = await until('page', () => hub.shownPage())
      const address = `http://127.0.0.1:${a.port}`
      await page.evaluate(() => {
        setTimeout(() => (location.href = `/redirect?to=${encodeURIComponent('/second')}`), 0)
      })
      await until('the page moves', async () => (await hub.shown()).visible[0].url === `${address}/second`)
      const inner = `/redirect?to=${encodeURIComponent(`http://127.0.0.1:${b.port}/`)}`
      await hub.evaluate(({ BaseWindow }, url) => {
        const [view] = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
        return view.webContents.loadURL(url)
      }, `${address}/framed?src=${encodeURIComponent(inner)}`)
      const framed = await until('the iframe loads beta', () =>
        hub.evaluate(({ BaseWindow }) => {
          const [view] = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
          return view.webContents.mainFrame.frames[0]?.url.endsWith('/') ? view.webContents.mainFrame.frames[0].url : null
        }, null),
      )
      assert.deepEqual(await hub.externals(), [])
      await a.stop()
      await b.stop()
      return `same-site redirect reached /second, the iframe reached ${framed}, and the default browser got nothing`
    }),
  )

  for (const shown of ['a page', 'the not running message']) {
    await check(section, `the sidebar comes back after its renderer dies, with ${shown} on screen`, async () => {
      const home = tempDir('home')
      const projects = tempDir('projects')
      const a = await startStub(home, join(projects, 'alpha'))
      const b = await startStub(home, join(projects, 'beta'))
      const hub = await BareHub.launch(home, tempDir('data'))
      // A script sent to a dead renderer never answers.
      const rows = () => Promise.race([hub.topRows(), sleep(500).then(() => [])])
      try {
        await until('two tabs', async () => (await rows()).length === 2)
        await until('alpha has focus', () =>
          hub.main(({ webContents }) => webContents.getFocusedWebContents()?.getURL().startsWith('http')),
        )
        if (shown !== 'a page') {
          await a.stop()
          await until('alpha dims', async () => (await rows()).find(({ label }) => label === 'alpha')?.dimmed)
        }
        const pid = await hub.main(({ BaseWindow }) =>
          (BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.getOSProcessId(),
        )
        process.kill(pid, 'SIGKILL')
        const started = Date.now()
        await until('the tabs return', async () => (await rows()).length === 2, NEXT_SCAN_MS * 2)
        const elapsed = Date.now() - started
        const c = await startStub(home, join(projects, 'gamma'))
        await until('a new project appears', async () => (await rows()).length === 3, NEXT_SCAN_MS)
        await c.stop()
        await hub.switchTab()
        await until('Ctrl+Tab selects beta', async () => (await rows()).find(({ selected }) => selected)?.label === 'beta')
        return `tabs returned ${elapsed} ms after the kill. A new project appeared, and Ctrl+Tab selected beta`
      } finally {
        await hub.quit()
        await a.stop()
        await b.stop()
      }
    })
  }

  await check(section, 'external links go to the default browser, and same-site links stay in the tab', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await hub.spyOnExternal()
      const page = await until('page', () => hub.shownPage())
      await page.locator('#external').waitFor()
      const start = page.url()
      // Playwright waits forever for a navigation that the app blocks, so measure first and then use the raw mouse.
      const boxes = Object.fromEntries(
        await Promise.all(
          ['#external', '#blank', '#file', '#same'].map(async (selector) => [selector, (await page.locator(selector).boundingBox())!] as const),
        ),
      )
      const clickLink = (selector: string) => {
        const box = boxes[selector]
        return page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      }
      const inPage = (code: string) =>
        hub.evaluate(({ webContents }, code) => {
          const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('http'))!
          return page.executeJavaScript(code).then(() => {})
        }, code)
      const shownUrl = async () => (await hub.shown()).visible[0].url
      await clickLink('#external')
      await clickLink('#blank')
      await inPage(`window.open('https://example.com/opened'); 0`)
      await inPage(`location.href = 'https://example.com/assigned'; 0`)
      await clickLink('#file')
      await until('all external calls', async () => (await hub.externals()).length >= 4)
      await sleep(200)
      const opened = await hub.externals()
      assert.deepEqual(opened.toSorted(), [
        'https://example.com/assigned',
        'https://example.com/blank',
        'https://example.com/opened',
        'https://example.com/plain',
      ])
      assert.equal(await shownUrl(), start)
      await clickLink('#same')
      await until('same-site navigation', async () => (await shownUrl()).endsWith('/second'))
      assert.equal((await hub.externals()).length, 4)
      assert.equal((await hub.shown()).pages, 1)
      await a.stop()
      return `shell.openExternal (replaced by a spy) got ${opened.length} addresses. A file: link was refused. The tab stayed on ${start}, and /second loaded in the tab.`
    }),
  )

  await check(section, 'rename: Enter saves, Escape cancels, blank goes back to the folder name', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await hub.rename('alpha', 'One')
      await appear(hub, 'One')
      assert.equal(hub.savedTabs()[0].name, 'One')
      await hub.rename('One', 'Two', 'Escape')
      await sleep(100)
      assert.deepEqual(await hub.labels(), ['One'])
      await hub.rename('One', '   ')
      await appear(hub, 'alpha')
      assert.equal(hub.savedTabs()[0].name, null)
      await a.stop()
      return 'names went One, One after Escape, then alpha with a null saved name'
    }),
  )

  await check(section, 'clicking another tab during a rename saves the name, and the list stays usable', () =>
    withHub(async ({ hub, home, projects }) => {
      const stubs = await Promise.all(['alpha', 'beta'].map((name) => startStub(home, join(projects, name))))
      await appear(hub, 'beta')
      await hub.topRow('beta').dblclick()
      await hub.shell().locator('input.rename').fill('Renamed')
      await hub.select('alpha')
      await appear(hub, 'Renamed')
      assert.equal((await hub.topRows()).find((tab) => tab.selected)?.label, 'alpha')
      for (const stub of stubs) await stub.stop()
      return 'the input closed, the name Renamed was saved, and alpha was selected'
    }),
  )

  await check(section, 'Rename in the row menu (native menu stubbed) from a right-click, the ⋯ button, and Shift+F10', () =>
    withHub(async ({ hub, home, projects }) => {
      const stubs = await Promise.all(['alpha', 'beta'].map((name) => startStub(home, join(projects, name))))
      await appear(hub, 'beta')
      const input = hub.shell().locator('input.rename')

      await hub.planMenus(['Rename'])
      await hub.topRow('alpha').click({ button: 'right' })
      await until('the rename input has focus', () => input.evaluate((element) => element === document.activeElement).catch(() => false))
      assert.equal(await input.inputValue(), 'alpha')
      await hub.screenshot(join(EVIDENCE, 'rules-rename-from-menu.png'))
      await input.fill('Right')
      await input.press('Enter')
      await appear(hub, 'Right')
      const rowKey = `row:${await hub.topRow('Right').getAttribute('data-root')}`
      assert.equal(hub.savedTabs().find((tab) => tab.name === 'Right')?.root, rowKey.slice(4))
      await until('focus on the renamed row', async () => (await hub.focusedInShell()) === rowKey, 2000)

      await hub.planMenus(['Rename'])
      await hub.topRow('beta').locator('.row-menu').click()
      await until('the rename input', () => input.count().then((count) => count === 1))
      await input.fill('Dropped')
      await input.press('Escape')
      await sleep(100)
      assert.deepEqual((await hub.labels()).sort(), ['Right', 'beta'])

      await hub.topRow('Right').focus()
      await hub.planMenus(['Rename'])
      await hub.shell().keyboard.press('Shift+F10')
      await until('the rename input has focus', () => input.evaluate((element) => element === document.activeElement).catch(() => false))
      await hub.shell().keyboard.type('Keys')
      await hub.shell().keyboard.press('Enter')
      await appear(hub, 'Keys')
      await until('focus back on the row', async () => (await hub.focusedInShell()) === rowKey, 2000)

      const labels = (await hub.menusShown()).map((menu) => menu.items[0].label)
      assert.deepEqual(labels, ['Rename', 'Rename', 'Rename'])
      for (const stub of stubs) await stub.stop()
      return 'A right-click Rename opened the input on alpha with its name selected, and Enter saved Right with focus on the row. The ⋯ Rename on beta with Escape kept beta. Shift+F10 Rename from the keyboard saved Keys, and focus came back to the row.'
    }),
  )

  await check(section, 'a page that opens again during a rename does not take focus, and the name waits for Enter', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const a = await startStub(home, join(tempDir('projects'), 'alpha'))
    const hub = await BareHub.launch(home, userData)
    const focusedUrl = () => hub.main(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null)
    const input = () =>
      hub.inShell<{ value: string; focused: boolean } | null>(`(() => {
        const input = document.querySelector('input.rename')
        return input && { value: input.value, focused: document.hasFocus() && document.activeElement === input }
      })()`)
    const savedName = () => {
      const path = join(userData, 'tabs.json')
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).tabs[0]?.name ?? null) : null
    }
    try {
      await until('alpha loads', async () => (await hits(a)) === 1)
      await until('alpha has focus', async () => (await focusedUrl())?.startsWith('http'))
      const { x, y } = await hub.inShell<{ x: number; y: number }>(`(() => {
        const box = document.querySelector('#top .tab .label').getBoundingClientRect()
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
      })()`)
      await hub.focusSidebar()
      await hub.shellInput([
        { type: 'mouseMove', x, y },
        { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
        { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
        { type: 'mouseDown', x, y, button: 'left', clickCount: 2 },
        { type: 'mouseUp', x, y, button: 'left', clickCount: 2 },
      ])
      await until('the rename input has focus', async () => (await input())?.focused)
      await hub.type('Half')
      await until('the typed text', async () => (await input())?.value === 'Half')
      await hub.main(({ BaseWindow }) => {
        const [, view] = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
        view.webContents.forcefullyCrashRenderer()
      })
      await until('alpha opens again', async () => (await hits(a)) === 2, NEXT_SCAN_MS + 1000)
      await sleep(500)
      const after = { input: await input(), focused: (await focusedUrl())?.split(':')[0], saved: savedName() }
      assert.deepEqual(after, { input: { value: 'Half', focused: true }, focused: 'file', saved: null }, 'the rename keeps its text and focus, and nothing is saved')
      await hub.press(['Enter'])
      await until('Enter saves the name', () => savedName() === 'Half')
      await until('the row shows the name', () => hub.inShell<boolean>(`document.querySelector('#top .tab .label')?.textContent === 'Half'`))
      return 'after the page opened again, the sidebar kept focus with Half in the input and nothing saved. Enter saved Half.'
    } finally {
      await hub.quit()
      await a.stop()
    }
  })

  await check(section, 'a file dropped on either list, a heading, or the message area does not replace the shell', () =>
    withHub(async ({ hub, home, projects }) => {
      const path = join(projects, 'dropped.txt')
      writeFileSync(path, 'dropped')
      const shell = hub.shell()
      const before = shell.url()
      const shellUrl = () => hub.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.getURL(), null)
      await until('message', () => hub.message())
      const cdp = await shell.context().newCDPSession(shell)
      const data = { items: [], files: [path], dragOperationsMask: 1 }
      const drop = async (x: number, y: number) => {
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
          await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
        await sleep(500)
      }
      for (const [x, y] of [[100, 300], [800, 300]]) await drop(x, y)
      assert.equal(await shellUrl(), before)
      assert.equal(await hub.message(), 'No Ultimate running')

      const stub = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await until('the status row', () => hub.statusRow('alpha').count())
      const targets = await shell.evaluate(() =>
        Object.fromEntries(
          ['#top-title', '#top .tab', '#top', '#status-title', '.status-heading', '#status .tab', '#status'].map((selector) => {
            const box = document.querySelector(selector)!.getBoundingClientRect()
            const y = selector === '#top' || selector === '#status' ? box.bottom - 10 : box.y + box.height / 2
            return [selector, [Math.round(box.x + box.width / 2), Math.round(y)]]
          }),
        ),
      )
      for (const [x, y] of Object.values(targets)) await drop(x, y)
      assert.equal(await shellUrl(), before)
      assert.deepEqual(await hub.labels(), ['alpha'])
      assert.equal((await hub.statusList()).length, 1)
      await stub.stop()
      return `the shell stayed on its own page after a file drop on the empty sidebar, the message area, and with a tab open on ${Object.keys(targets).join(', ')}`
    }),
  )

  await check(section, 'the app menu takes no Ultimate shortcut', () =>
    withHub(async ({ hub }) => {
      const accelerators = await hub.evaluate(({ Menu }) => {
        const found: string[] = []
        const walk = (menu: Electron.Menu | null | undefined) => {
          for (const item of menu?.items ?? []) {
            const accelerator = item.accelerator ?? (item as unknown as { getDefaultRoleAccelerator(): string | undefined }).getDefaultRoleAccelerator()
            if (accelerator) found.push(String(accelerator))
            walk(item.submenu)
          }
        }
        walk(Menu.getApplicationMenu())
        return found
      }, null)
      const taken = accelerators.filter((value) =>
        /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl)\+(Shift\+|Alt\+)*([0-9]|K|B)$/i.test(value),
      )
      assert.deepEqual(taken, [])
      assert.ok(accelerators.length > 3, 'the walk saw the menu')
      return `${accelerators.length} accelerators, none on K, B, or a digit: ${accelerators.join(' ')}`
    }),
  )

  await check(section, 'the page view follows window resize', () =>
    withHub(async ({ hub, home, projects }) => {
      const a = await startStub(home, join(projects, 'alpha'))
      await appear(hub, 'alpha')
      await until('page', () => hub.shownPage())
      const bounds = await hub.evaluate(({ BaseWindow }) => {
        const [window] = BaseWindow.getAllWindows()
        window.setContentSize(1000, 700)
        return window.getContentSize()
      }, null)
      const shown = await until('layout', async () => {
        const view = (await hub.shown()).visible[0]
        return view.width === bounds[0] - SIDEBAR_WIDTH && view.x === SIDEBAR_WIDTH ? view : null
      })
      await a.stop()
      return `window ${bounds.join('x')}: page x=${shown.x}, width=${shown.width}`
    }),
  )

  await check(section, 'two projects with the same folder name keep separate tabs', () =>
    withHub(async ({ hub, home, projects }) => {
      const first = await startStub(home, join(projects, 'one', 'app'))
      const second = await startStub(home, join(projects, 'two', 'app'))
      await until('two tabs', async () => (await hub.topRows()).length === 2, NEXT_SCAN_MS)
      const roots = (await hub.topRows()).map((tab) => tab.root)
      assert.equal(new Set(roots).size, 2)
      await first.stop()
      await second.stop()
      return `tabs for ${roots.join(' and ')}`
    }),
  )
}
