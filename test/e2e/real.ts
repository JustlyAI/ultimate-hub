import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import {
  isAlive,
  listeningPorts,
  makeProject,
  projectHome,
  sleep,
  startScriptedModel,
  startUltimate,
  tempDir,
  until,
  type RealUltimate,
} from '../support/fixtures.ts'
import { BareHub } from '../support/bare.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { describeHealth, isSettled, READ_HEALTH, waitForSettled, type Health } from '../support/settle.ts'
import { appMemory, measureSwitches, median, p95 } from './scale.ts'

const NEXT_SCAN_MS = 2500
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function coreOf(pid: number): number {
  const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const row = output.split('\n').find((line) => {
    const [, ppid] = line.trim().split(/\s+/)
    return Number(ppid) === pid && line.includes('server/main.ts')
  })
  if (!row) throw new Error(`no core process under ${pid}`)
  return Number(row.trim().split(/\s+/)[0])
}

const titleHasRoot = async (page: Page, root: string) => (await page.title()).startsWith(root)

export async function showProject(hub: Hub, label: string, root: string): Promise<Page> {
  await hub.select(label)
  return until(`${label} page`, async () => {
    const page = await hub.shownPage()
    return (await titleHasRoot(page, root)) ? page : null
  }, 60000)
}

const pieces = async (page: Page) => ((await page.locator('body').innerText()).match(/piece\d+/g) ?? []).length

export async function send(page: Page, text: string) {
  const composer = page.locator('#composer-input')
  await composer.fill(text)
  await composer.press('Enter')
}

/** Follows the selected view of the first project from the moment it opens until Ultimate's composer shows. */
async function watchBoot(hub: Hub) {
  const urls = new Set<string>()
  const viewIds = new Set<number>()
  await until('a view', async () => (await hub.shown()).visible[0], 60000)
  const started = Date.now()
  for (;;) {
    for (const shown of (await hub.shown()).visible) {
      urls.add(shown.url || '(loading)')
      viewIds.add(shown.id)
    }
    const page = hub.pageAt((await hub.shown()).visible[0]?.url)
    if (page && (await page.locator('#composer-input').count())) break
    if (Date.now() - started > 60000) throw new Error('the composer never showed')
    await sleep(25)
  }
  return { urls: [...urls], viewIds: [...viewIds], composerAfterTabMs: Date.now() - started }
}

const VITE_RELOAD = 'optimized dependencies changed. reloading'

/** On a fresh install, Ultimate's own Vite server reloads the page when a surface first needs a new dependency. */
export async function settled(home: string, root: string, page: Page) {
  const log = join(projectHome(home, root), 'supervisor.log')
  await until(
    'no Vite reload for 6 s',
    () => {
      const reloads = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes(VITE_RELOAD))
      const last = reloads.at(-1)
      return !last || Date.now() - Date.parse(JSON.parse(last).at) > 6000
    },
    60000,
  )
  await page.locator('#composer-input').waitFor({ timeout: 60000 })
  await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
}

export async function runRealChecks(check: Check) {
  const home = tempDir('home')
  const userData = tempDir('data')
  const projects = tempDir('projects')
  const model = await startScriptedModel()
  const roots = ['alpha-proj', 'beta-proj', 'gamma-proj'].map((name) => makeProject(projects, name))
  const [rootA, rootB, rootC] = roots
  const running = new Map<string, RealUltimate>()
  let hub = await Hub.launch(home, userData)

  const shot = (name: string) => hub.screenshot(join(EVIDENCE, name))

  const measured: Record<string, unknown> = {}
  try {
    await check('real', 'no setup: the empty window shows that no Ultimate is running', async () => {
      await until('message', async () => (await hub.message()) === 'No Ultimate running')
      await shot('01-no-instances.png')
      return `"${await hub.message()}". Screenshot 01-no-instances.png`
    })

    let lockEvidence = ''
    let bootResult = { urls: [] as string[], viewIds: [] as number[], composerAfterTabMs: 0 }
    const lockOnly: { label: string; tabAfterLockMs: number; projectFileAtTab: boolean; projectFileAfterLockMs: number }[] = []
    await check('real', 'three real Ultimates with --no-open appear, each tab with the correct project', async () => {
      const appeared: string[] = []
      for (const root of roots) {
        const label = root.split('/').pop()!
        const lockPath = join(projectHome(home, root), 'ultimate.lock')
        const projectPath = join(projectHome(home, root), 'project.json')
        const instance = startUltimate(home, root, model.agentDir)
        running.set(root, instance)
        const bootWatch = root === rootA ? watchBoot(hub) : undefined
        const lockPorts: number[] = []
        let watching = true
        const watcher = (async () => {
          while (watching) {
            try {
              const { port } = JSON.parse(readFileSync(lockPath, 'utf8'))
              if (lockPorts.at(-1) !== port) lockPorts.push(port)
            } catch {}
            await sleep(1)
          }
        })()
        const others = [...running.values()].filter((other) => other !== instance)
        const otherPorts = await Promise.all(others.map((other) => other.port()))
        let wrong = 0
        const port = await instance.port()
        watching = false
        await watcher
        const provenAt = Date.now()
        const tab = await until(`${label} tab`, async () => {
          const row = await hub.tab(label)
          if (row && row.port !== null && otherPorts.includes(row.port)) wrong++
          return row && !row.dimmed ? row : null
        }, NEXT_SCAN_MS)
        const tabAt = Date.now()
        const projectFileAtTab = existsSync(projectPath)
        const fileAfter = await until(`${label} project file`, () => (existsSync(projectPath) ? Date.now() - provenAt : null), 60000)
        lockOnly.push({ label, tabAfterLockMs: tabAt - provenAt, projectFileAtTab, projectFileAfterLockMs: fileAfter })
        assert.equal(wrong, 0)
        assert.equal(tab.port, port)
        assert.equal(tab.root, root)
        appeared.push(`${label}:${port} after ${tabAt - provenAt} ms`)
        lockEvidence += `${label} lock ports over startup: ${lockPorts.join(' then ')}. `
        if (bootWatch) bootResult = await bootWatch
      }
      for (const root of roots) {
        const label = root.split('/').pop()!
        const page = await showProject(hub, label, root)
        await page.locator('#composer-input').waitFor({ timeout: 60000 })
        const body = await page.locator('body').innerText()
        assert.ok(body.includes(label), `${label} page body`)
        for (const other of roots.filter((candidate) => candidate !== root))
          assert.ok(!body.includes(other.split('/').pop()!), 'no other project on the page')
      }
      const last = await hub.shownPage()
      await settled(home, rootC, last)
      await shot('02-three-real-tabs.png')
      return `${appeared.join(', ')}. Each page title starts with its root, and each body names only its project. Screenshot 02-three-real-tabs.png, taken after the tab settled.`
    })

    await check('real lock', 'the lock alone is enough on a real start: the tab and page open before project.json, and the page survives core boot', async () => {
      assert.equal(new Set(bootResult.viewIds).size, 1, `views during boot: ${bootResult.viewIds.join()}`)
      assert.ok(bootResult.urls.every((url) => url === '(loading)' || url.startsWith('http://127.0.0.1')), bootResult.urls.join())
      assert.ok(lockOnly.every(({ tabAfterLockMs }) => tabAfterLockMs < NEXT_SCAN_MS))
      measured.lockOnly = { starts: lockOnly, boot: bootResult }
      const early = lockOnly.filter(({ projectFileAtTab }) => !projectFileAtTab).length
      return `${lockOnly.map(({ label, tabAfterLockMs, projectFileAfterLockMs, projectFileAtTab }) => `${label}: tab ${tabAfterLockMs} ms after the lock was proven, project.json ${projectFileAfterLockMs} ms after, present at the tab: ${projectFileAtTab}`).join('. ')}. ${early} of ${lockOnly.length} tabs came before project.json. The first project's page stayed in one view through core boot, with no failed load, and its composer showed ${bootResult.composerAfterTabMs} ms after the view opened. Addresses: ${bootResult.urls.join(', ')}`
    })

    await check('real lock', 'a real starting Ultimate holds a lock with a port that another project owns', async () => {
      assert.match(lockEvidence, /(\d+) then (?!\1)\d+/, `no lock changed port. ${lockEvidence}`)
      return lockEvidence
    })

    await check('real', 'conversation streaming works in a tab', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      const before = await pieces(page)
      await send(page, 'please stream')
      const counts: number[] = []
      await until('all pieces', async () => {
        const count = (await pieces(page)) - before
        if (counts.at(-1) !== count) counts.push(count)
        return count >= 20
      }, 30000)
      assert.ok(counts.length >= 5, `saw counts ${counts.join()}`)
      await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
      await shot('06-streamed.png')
      return `piece count on screen grew in steps: ${counts.join(', ')}. Screenshot 06-streamed.png`
    })

    await check('real', '⌘K opens the Ultimate palette, not an app feature', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      await until('page focus', async () => (await hub.focusedUrl())?.startsWith('http'))
      await hub.key('K', ['meta'])
      const palette = page.locator('[cmdk-root]')
      await palette.waitFor({ timeout: 5000 })
      await shot('07-palette.png')
      await page.keyboard.press('Escape')
      await palette.waitFor({ state: 'detached', timeout: 5000 })
      assert.equal((await hub.topRows()).find((tab) => tab.selected)?.label, 'alpha-proj')
      return 'palette opened from a key event sent through the browser process, and Escape closed it. Screenshot 07-palette.png'
    })

    await check('real', 'mod+1…9 switch Ultimate surfaces in the tab, not app tabs', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      await until('page focus', async () => (await hub.focusedUrl())?.startsWith('http'))
      const titles: string[] = []
      for (const digit of ['2', '3', '4', '1']) {
        const before = await page.title()
        await hub.key(digit, ['meta'])
        await until(`mod+${digit}`, async () => (await page.title()) !== before, 5000)
        titles.push((await page.title()).split(' · ').pop()!)
      }
      for (const digit of ['5', '6', '7', '8', '9']) await hub.key(digit, ['meta'])
      await sleep(200)
      assert.equal((await hub.topRows()).find((tab) => tab.selected)?.label, 'alpha-proj')
      assert.equal(new Set(titles).size, 4)
      return `mod+2, 3, 4, 1 gave surfaces ${titles.join(', ')}. mod+5 to 9 did not change the app tab. Ultimate has 4 surfaces in this project.`
    })

    await check('zoom', '⌘=, ⌘⇧=, and ⌘- pass a real Ultimate page with no preventDefault, and Zoom In (menu item clicked from the main process) zooms it', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      await until('page focus', async () => (await hub.focusedUrl())?.startsWith('http'))
      await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
      await page.evaluate(() => {
        const heard: string[] = []
        ;(window as unknown as { zoomKeys: string[] }).zoomKeys = heard
        window.addEventListener('keydown', (event) => {
          if (event.metaKey && !['Meta', 'Shift'].includes(event.key)) setTimeout(() => heard.push(`${event.code}${event.shiftKey ? '+shift' : ''} prevented=${event.defaultPrevented}`))
        }, { capture: true })
      })
      for (const modifiers of [['meta'], ['meta', 'shift']]) await hub.key('=', modifiers)
      await hub.key('-', ['meta'])
      await hub.key('0', ['meta'])
      const heard = await until('four keys', async () => {
        const keys = await page.evaluate(() => (window as unknown as { zoomKeys: string[] }).zoomKeys)
        return keys.length === 4 ? keys : null
      })
      assert.deepEqual(heard.slice(0, 3), ['Equal prevented=false', 'Equal+shift prevented=false', 'Minus prevented=false'])
      const zoomItem = (label: string) =>
        hub.evaluate(({ Menu }, label) => {
          const view = Menu.getApplicationMenu()!.items.find((item) => item.label === 'View')!
          view.submenu!.items.find((item) => item.label === label && item.visible)!.click()
        }, label)
      const factor = () => hub.evaluate(({ BaseWindow }) => {
        const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
        return pages.find((view) => view.getVisible())!.webContents.getZoomFactor()
      }, null)
      try {
        await zoomItem('Zoom In')
        await zoomItem('Zoom In')
        await until('125%', async () => Math.round((await factor()) * 100) === 125, 5000)
        await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
        await shot('real-zoom-125.png')
      } finally {
        await zoomItem('Actual Size')
      }
      await until('100%', async () => (await factor()) === 1, 5000)
      return `the page heard ${heard.join(', ')}. ⌘0 is Ultimate's own key, the control. Two Zoom In gave 125%, Actual Size gave 100%. Screenshot real-zoom-125.png`
    })

    await check('real', 'a dropped image reaches the model from a tab', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      await settled(home, rootA, page)
      const path = join(tempDir('upload'), 'dot.png')
      writeFileSync(path, PNG)
      const composer = page.locator('#composer-input')
      const box = (await composer.boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      const data = { items: [], files: [path], dragOperationsMask: 1 }
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, data }
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at })
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...at })
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...at })
      const preview = page.locator('img[src^="data:image/png"]')
      await preview.first().waitFor({ timeout: 5000 })
      await shot('08-dropped-image.png')
      const seen = model.requests.length
      await send(page, 'image by drop')
      const request = await until('model request', () =>
        model.requests.slice(seen).find(({ lastText, images }) => lastText.includes('image by drop') && images > 0),
      )
      return `preview shown in the composer, and the model got ${request.images} image part. Screenshot 08-dropped-image.png`
    })

    await check('real', 'a pasted image and pasted text work through the Edit menu', async () => {
      const page = await showProject(hub, 'alpha-proj', rootA)
      await settled(home, rootA, page)
      const composer = page.locator('#composer-input')
      await composer.click()
      const saved = await hub.evaluate(({ clipboard }) => clipboard.readText(), null)
      try {
        const paste = (kind: 'text' | 'image') =>
          hub.evaluate(
            async ({ clipboard, ClipboardItem, Menu }, { kind, png }) => {
              if (kind === 'text') await clipboard.writeText('pasted through the menu')
              else {
                const blob = new Blob([Buffer.from(png, 'base64')], { type: 'image/png' })
                await clipboard.write([new ClipboardItem({ 'image/png': blob })])
              }
              const edit = Menu.getApplicationMenu()!.items.find(({ label }) => label === 'Edit')!
              if (!edit.submenu!.items.some(({ role }) => role?.toLowerCase() === 'paste')) throw new Error('no Paste item')
              Menu.sendActionToFirstResponder('paste:')
            },
            { kind, png: PNG.toString('base64') },
          )
        await paste('text')
        await until('pasted text', async () => (await composer.inputValue()) === 'pasted through the menu', 3000)
        await hub.evaluate(async ({ clipboard, Menu }) => {
          await clipboard.writeText('')
          Menu.sendActionToFirstResponder('selectAll:')
        }, null)
        await sleep(200)
        await hub.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('copy:'), null)
        await until(
          'copied text',
          async () => {
            const copied = await hub.evaluate(({ clipboard }) => clipboard.readText(), null)
            if (copied !== 'pasted through the menu') throw new Error(`clipboard holds "${copied}"`)
            return true
          },
          3000,
        )
        await composer.fill('')
        const before = await page.locator('img[src^="data:image/png"]').count()
        await paste('image')
        await until('pasted image', async () => (await page.locator('img[src^="data:image/png"]').count()) > before, 3000)
      } finally {
        await hub.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
      }
      const seen = model.requests.length
      await send(page, 'image by paste')
      const request = await until('model request', () =>
        model.requests.slice(seen).find(({ lastText, images }) => lastText.includes('image by paste') && images > 0),
      )
      return `select all, copy, and paste of text, and paste of an image, through macOS's first responder, the path that the Edit menu items use. The model got ${request.images} image part. The clipboard text was put back after the check.`
    })

    await check('real', 'a link in a conversation opens the default browser, and the tab stays', async () => {
      await hub.spyOnExternal()
      const page = await showProject(hub, 'alpha-proj', rootA)
      await settled(home, rootA, page)
      await send(page, 'please send a link')
      const link = page.getByText('the example site', { exact: true }).last()
      await link.waitFor({ timeout: 30000 })
      const url = page.url()
      // A late update of the message can close Ultimate's dialog, so try again until the dialog takes the click.
      await until(
        'the link dialog',
        async () => {
          await link.click({ noWaitAfter: true, timeout: 3000 })
          await page.getByRole('button', { name: 'Open link', exact: true }).click({ noWaitAfter: true, timeout: 1500 })
          return true
        },
        20000,
      )
      const opened = await until('external open', async () => {
        const urls = await hub.externals()
        return urls.length ? urls : null
      }, 3000)
      assert.deepEqual(opened, ['https://example.com/from-model'])
      assert.equal(page.url(), url)
      return `Ultimate's own "Open external link?" dialog came first, as in Chrome. Then shell.openExternal (a spy here, so that no real browser opens) got ${opened[0]}, and the tab stayed on ${url.split('?')[0]}`
    })

    await check('real view', 'an instance with its own ULTIMATE_HOME does not appear', async () => {
      const root = makeProject(projects, 'elsewhere-proj')
      const other = startUltimate(home, root, model.agentDir, { env: { ULTIMATE_HOME: join(tempDir('home'), 'state') } })
      running.set(root, other)
      await until('it to listen', () => listeningPorts([other.child.pid!]).length > 0, 30000)
      await sleep(NEXT_SCAN_MS)
      assert.ok(!(await hub.labels()).includes('elsewhere-proj'))
      await other.stop()
      running.delete(root)
      return 'a running instance outside ~/.ultimate/projects stayed out of the list'
    })

    let newPort = 0
    await check('real', 'rename, stop, restart on another port: name stays and the tab shows the correct project', async () => {
      await hub.rename('alpha-proj', 'Website')
      await until('renamed', () => hub.tab('Website'))
      await waitForSettled(async () => (await hub.shownPage()).evaluate(READ_HEALTH) as Promise<Health>)
      await shot('03-renamed-tab.png')
      assert.equal(hub.savedTabs().find(({ root }) => root === rootA)?.name, 'Website')
      const oldPort = (await hub.tab('Website'))!.port!
      await showProject(hub, 'Website', rootA)
      const stopping = running.get(rootA)!
      await stopping.stop()
      await until('dim', async () => (await hub.tab('Website'))?.dimmed, NEXT_SCAN_MS + 500)
      await until('message', async () => (await hub.message()) === 'Website is not running')
      assert.deepEqual((await hub.shown()).visible, [])
      await shot('04-dimmed-not-running.png')
      newPort = oldPort + 100
      const restarted = startUltimate(home, rootA, model.agentDir, { port: newPort })
      running.set(rootA, restarted)
      await until('live on the new port', async () => (await hub.tab('Website'))?.port === newPort, 60000)
      const page = await until('page at the new address', async () => {
        const shown = await hub.shownPage()
        return shown.url().includes(`:${newPort}`) && (await titleHasRoot(shown, rootA)) ? shown : null
      }, 60000)
      await page.locator('#composer-input').waitFor({ timeout: 60000 })
      assert.ok((await page.locator('body').innerText()).includes('alpha-proj'))
      assert.deepEqual(await hub.labels(), ['Website', 'beta-proj', 'gamma-proj'])
      await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
      await shot('05-returned-on-new-port.png')
      return `port ${oldPort} to ${newPort}. Name Website and first position kept. Page title starts with ${rootA}. Screenshots 03, 04, 05.`
    })

    await check('real', 'quit and reopen: names and order are the same, and every Ultimate still runs', async () => {
      await hub.drag('gamma-proj', 'Website', 'top')
      await until('moved', async () => (await hub.labels())[0] === 'gamma-proj')
      const before = await hub.labels()
      const instances = [...running.values()]
      const supervisors = instances.map((instance) => instance.child.pid!)
      const cores = supervisors.map(coreOf)
      const ports = await Promise.all(instances.map((instance) => instance.port()))
      const files = roots.flatMap((root) =>
        ['project.json', 'ultimate.lock'].map((name) => join(projectHome(home, root), name)),
      )
      const hashes = files.map(fileHash)
      const appPid = hub.pid
      await hub.quit()
      await until('app exit', () => !isAlive(appPid))
      await sleep(2000)
      supervisors.forEach((pid) => assert.ok(isAlive(pid), `supervisor ${pid} after quit`))
      cores.forEach((pid) => assert.ok(isAlive(pid), `core ${pid} after quit`))
      instances.forEach((instance, index) =>
        assert.deepEqual(listeningPorts([instance.child.pid!]), [ports[index]], 'supervisor keeps its port'),
      )
      for (const port of ports) assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
      hub = await Hub.launch(home, userData)
      await until('all tabs live', async () => {
        const tabs = await hub.topRows()
        return tabs.length === 3 && tabs.every((tab) => !tab.dimmed)
      }, NEXT_SCAN_MS + 1000)
      const after = await hub.labels()
      assert.deepEqual(after, before)
      const page = await showProject(hub, 'Website', rootA)
      await page.locator('#composer-input').waitFor({ timeout: 60000 })
      await waitForSettled(() => page.evaluate(READ_HEALTH) as Promise<Health>)
      assert.deepEqual(files.map(fileHash), hashes, "Ultimate's files did not change")
      supervisors.forEach((pid) => assert.ok(isAlive(pid)))
      cores.forEach((pid) => assert.ok(isAlive(pid)))
      await shot('09-after-reopen.png')
      return `order before and after: ${after.join(', ')}. Supervisor pids ${supervisors.join(', ')} and core pids ${cores.join(', ')} alive, on the same ports, with HTTP 200 while the app was closed. Lock and project file hashes unchanged. Screenshot 09-after-reopen.png`
    })

    await check('groups', 'with real Ultimates, a group that is made, filled, collapsed, expanded, and removed (menus and sheet stubbed) stops, restarts, and reloads nothing', async () => {
      const instances = [...running.values()]
      const supervisors = instances.map((instance) => instance.child.pid!)
      const cores = supervisors.map(coreOf)
      const ports = await Promise.all(instances.map((instance) => instance.port()))
      const files = roots.flatMap((root) => ['project.json', 'ultimate.lock'].map((name) => join(projectHome(home, root), name)))
      const hashes = files.map(fileHash)
      const shown = await hub.shown()
      const loadedAt = await (await hub.shownPage()).evaluate(() => performance.timeOrigin)
      const header = () => hub.shell().locator('#top .group-header', { has: hub.shell().locator('.name:text-is("Real")') })
      await hub.planMenus(['Group', 'Real', 'Remove group'])
      await hub.planSheets(['action'])
      await hub.shell().locator('#add').click()
      await until('the name dialog', () => hub.shell().evaluate(() => document.querySelector<HTMLDialogElement>('#name-dialog')!.open))
      await hub.shell().keyboard.type('Real')
      await hub.shell().keyboard.press('Enter')
      await until('the Real group', () => header().count())
      await hub.topRow('beta-proj').click({ button: 'right' })
      await until('beta-proj in Real', () => header().locator('xpath=..').locator('.tab .label:text-is("beta-proj")').count())
      await header().locator('.toggle').click()
      await until('Real collapsed', async () => (await header().locator('.toggle').getAttribute('aria-expanded')) === 'false')
      // capturePage returns the last painted frame, which can be older than the DOM.
      await sleep(300)
      await shot('35-real-group-collapsed.png')
      await header().locator('.toggle').click()
      await until('Real expanded', async () => (await header().locator('.toggle').getAttribute('aria-expanded')) === 'true')
      await header().locator('.group-menu').click()
      await until('Real removed', async () => (await header().count()) === 0)
      await sleep(1000)
      supervisors.forEach((pid) => assert.ok(isAlive(pid), `supervisor ${pid}`))
      cores.forEach((pid) => assert.ok(isAlive(pid), `core ${pid}`))
      instances.forEach((instance, index) => assert.deepEqual(listeningPorts([instance.child.pid!]), [ports[index]], 'supervisor keeps its port'))
      assert.deepEqual(files.map(fileHash), hashes, "Ultimate's files did not change")
      assert.deepEqual(await hub.shown(), shown, 'the same page views')
      assert.equal(await (await hub.shownPage()).evaluate(() => performance.timeOrigin), loadedAt, 'the shown page did not reload')
      assert.deepEqual((await hub.sheetsShown()).map(({ text }) => text), ['Instances move to Ungrouped. Their servers keep running.'])
      return `Real was made, beta-proj moved into it, it collapsed and expanded, and it was removed after the sheet (screenshot 35-real-group-collapsed.png). Supervisors ${supervisors.join(', ')} and cores ${cores.join(', ')} still ran on the same ports, Ultimate's files had the same hashes, and the shown page kept its load time ${loadedAt}.`
    })

    await check('safety', 'the app does not stop or restart any Ultimate during the whole run', async () => {
      for (const [root, instance] of running) assert.ok(isAlive(instance.child.pid!), root)
      return `all ${running.size} real instances still run. Each one that stopped was stopped by this script.`
    })

    await hub.quit()
    const bare = await BareHub.launch(home, userData)
    try {
      await until('three live tabs', async () => (await bare.topRows()).filter((tab) => tab.port !== null).length === 3, 5000)
      const firstLoads: number[] = []
      for (let index = 0; index < 3; index++) {
        const started = Date.now()
        await until('a real page', () => bare.inShown('!!document.querySelector("#composer-input")'), 60000)
        firstLoads.push(Date.now() - started)
        await bare.switchTab()
        await sleep(100)
      }
      await sleep(3000)
      measured.firstSelectToComposerMs = firstLoads

      await check('real view', 'real tabs, with no debugger on the pages: hidden pages are hidden, plus memory and switch time', async () => {
        const states = await bare.inAllPages<string>('document.visibilityState')
        assert.equal(states.length, 3)
        assert.equal(states.filter((state) => state === 'hidden').length, 2)
        await bare.inAllPages(`void document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') return
          requestAnimationFrame(() => requestAnimationFrame(() => { window.shownAt = Date.now() }))
        })`)
        const samples = await measureSwitches(bare, 60)
        const pages = await bare.main(({ app, BaseWindow }) => {
          const metrics = app.getAppMetrics()
          const views = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
          return views.map(({ webContents }) => Math.round((metrics.find(({ pid }) => pid === webContents.getOSProcessId())?.memory.workingSetSize ?? 0) / 1024))
        })
        const firstCaptures = await bare.main(async ({ BaseWindow, webContents }) => {
          const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
          const visible = () => pages.find((view) => view.getVisible())!
          const results: { ms: number; differingPixels: number }[] = []
          for (let index = 0; index < 12; index++) {
            const from = visible()
            const sentAt = Date.now()
            webContents.getFocusedWebContents()!.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
            while (visible() === from) await new Promise((resolve) => setImmediate(resolve))
            const target = visible()
            const first = (await target.webContents.capturePage()).toBitmap()
            const ms = Date.now() - sentAt
            await new Promise((resolve) => setTimeout(resolve, 600))
            const settled = (await target.webContents.capturePage()).toBitmap()
            let differing = 0
            for (let at = 0; at < first.length; at += 4)
              if (Math.abs(first[at] - settled[at]) + Math.abs(first[at + 1] - settled[at + 1]) + Math.abs(first[at + 2] - settled[at + 2]) > 24) differing++
            results.push({ ms, differingPixels: differing / (first.length / 4) })
          }
          return results
        })
        const worstDifference = Math.max(...firstCaptures.map(({ differingPixels }) => differingPixels))
        const captureMs = median(firstCaptures.map(({ ms }) => ms))
        assert.ok(worstDifference < 0.02, `first capture differed from the settled view in ${(worstDifference * 100).toFixed(1)}% of pixels`)
        const memory = await appMemory(bare)
        measured.realTabs = { firstCaptureMedianMs: captureMs, worstFirstCaptureDifference: worstDifference, switches: samples.length, medianMs: median(samples), p95Ms: p95(samples), maxMs: Math.max(...samples), workingSetMbPerPage: pages, memory }
        return `Three real tabs: ${pages.join(', ')} MB working set per page, ${memory.totalWorkingSetMb} MB for the whole app. 60 switches: median ${median(samples)} ms, p95 ${p95(samples)} ms, max ${Math.max(...samples)} ms. 12 captures taken right after a switch (median ${captureMs} ms including capture) differed from the view 600 ms later in at most ${(worstDifference * 100).toFixed(2)}% of pixels. First select to composer: ${firstLoads.join(', ')} ms.`
      })

      const selected = async () => (await bare.topRows()).find((tab) => tab.selected)!
      const showB = async () => {
        while ((await selected()).root !== rootB) {
          await bare.switchTab()
          await sleep(100)
        }
      }
      const draft = () => bare.inShown<string>(`document.querySelector('#composer-input').value`)

      await check('real', "with no debugger, Ultimate's first-run dialog works in a tab, with a real Escape", async () => {
        await showB()
        await until('the dialog', () => bare.inShown(`document.querySelector('[role=dialog]')?.innerText.includes('Get ready') === true`), 10000)
        await until(
          'the dialog to close',
          async () => {
            await bare.press(['Escape'])
            await sleep(300)
            return bare.inShown(`!document.querySelector('[role=dialog]')`)
          },
          10000,
        )
        return 'the dialog showed, because a page with no debugger is not an automated browser, and a real Escape closed it. Playwright pages never get this dialog.'
      })

      await check('real', 'real clicks and keys reach the composer, and typing continues after switching away and back', async () => {
        await showB()
        await bare.click('#composer-input')
        await sleep(150)
        assert.equal(await bare.inShown(`document.activeElement?.id`), 'composer-input', 'the click focused the composer')
        let expected = ''
        for (let round = 0; round < 10; round++) {
          const letter = String.fromCharCode(97 + round)
          await bare.type(letter)
          expected += letter
          await until(`"${expected}" in the composer`, async () => (await draft()) === expected, 3000)
          await bare.switchTab()
          await until('another tab', async () => (await selected()).root !== rootB, 3000)
          await sleep(50)
          await showB()
          await sleep(50)
        }
        await bare.press(new Array(expected.length).fill('Backspace'))
        await until('an empty composer', async () => (await draft()) === '', 3000)
        return `10 rounds of Ctrl+Tab away and back. With no further click, each key landed in the composer, giving "${expected}".`
      })

      await check('real', 'a real stream continues while its tab is truly hidden', async () => {
        const count = () => bare.inShown<number>(`(document.body.innerText.match(/piece\\d+/g) ?? []).length`)
        await showB()
        const before = await count()
        const message = 'please stream while hidden'
        await bare.click('#composer-input')
        await sleep(100)
        await bare.type(message)
        await until('the typed message', async () => (await draft()) === message, 5000)
        const requestsBefore = model.requests.length
        await bare.press(['Return'])
        await until('the stream to start', async () => (await count()) > before, 15000).catch(async (error) => {
          const state = await bare.inShown(`({ draft: document.querySelector('#composer-input')?.value, active: document.activeElement?.tagName, dialog: document.querySelector('[role=dialog]')?.innerText.slice(0, 40), origin: performance.timeOrigin })`)
          throw new Error(`${error.message}. State: ${JSON.stringify(state)}. Model requests: ${JSON.stringify(model.requests.slice(requestsBefore))}`)
        })
        const atHide = (await count()) - before
        assert.ok(atHide < 20, 'the stream had not ended')
        await bare.switchTab()
        await sleep(200)
        const portB = (await bare.topRows()).find(({ root }) => root === rootB)!.port
        const hidden = await bare.inAllPages<[string, string]>('[document.visibilityState, location.port]')
        assert.equal(hidden.find(([, port]) => port === String(portB))?.[0], 'hidden')
        await sleep(4500)
        await bare.switchTab(true)
        const after = await until('all pieces', async () => {
          const pieces = (await count()) - before
          return pieces >= 20 ? pieces : null
        }, 3000)
        return `hidden at ${atHide} of 20 pieces with visibilityState hidden. ${after} pieces were on screen when the tab came back.`
      })

      const healthOfShown = () => bare.inShown<Health>(READ_HEALTH)
      await check('settle', 'a real tab with no debugger settles with live and no error toasts', async () => {
        await showB()
        await waitForSettled(healthOfShown)
        const health = await healthOfShown()
        return `${describeHealth(health)}, read from the page.`
      })

      await check('settle', 'negative control: the settle check fails when real error toasts show', async () => {
        await showB()
        await bare.inShown(`void (window.realFetch = window.fetch, window.fetch = () => Promise.reject(new TypeError('Failed to fetch')))`)
        for (const digit of ['2', '1'])
          await bare.main(({ webContents }, digit) => webContents.getFocusedWebContents()!.sendInputEvent({ type: 'keyDown', keyCode: digit, modifiers: ['meta'] }), digit)
        let health: Health | undefined
        await until('a real error toast', async () => {
          health = await healthOfShown()
          return health.toasts.length > 0
        }, 15000)
        assert.equal(isSettled(health!), false)
        const failure = await waitForSettled(healthOfShown, 1000).then(() => null, (error: Error) => error.message)
        assert.match(failure ?? '', /did not settle/)
        await bare.inShown(`void (window.fetch = window.realFetch)`)
        await bare.main(({ BaseWindow }) => {
          const views = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
          views.find((view) => view.getVisible())!.webContents.reload()
        })
        await sleep(500)
        await until('the page after reload', () => bare.inShown('!!document.querySelector("#composer-input")'), 30000)
        await waitForSettled(healthOfShown)
        return `with fetch broken in the page, Ultimate raised real toasts and the check said: "${failure?.slice(0, 120)}". After a reload it settled again.`
      })

      await check('settle', 'negative control: the settle check fails while the stream is down', async () => {
        await showB()
        const instance = running.get(rootB)!
        const core = coreOf(instance.child.pid!)
        process.kill(core, 'SIGKILL')
        const seen = await until('the status bar to show the loss', async () => {
          const health = await healthOfShown()
          return health.status === 'reconnecting…' ? health : null
        }, 5000)
        assert.equal(isSettled(seen), false)
        await until('the supervisor to start a new core', () => coreOf(instance.child.pid!) !== core, 30000).catch(() => {})
        return `killing the core of a real Ultimate, a process this script started, gave ${describeHealth(seen)}, which the check rejects.`
      })

      await check('rule', 'a real Ultimate killed with SIGKILL leaves a stale lock, and the app treats it as stopped', async () => {
        const lockPath = join(projectHome(home, rootC), 'ultimate.lock')
        const instance = running.get(rootC)!
        await bare.main(() => {})
        while ((await bare.topRows()).find((tab) => tab.selected)?.root === rootC) await bare.switchTab()
        await instance.crash()
        running.delete(rootC)
        assert.ok(existsSync(lockPath), 'the lock stays behind')
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        assert.equal(isAlive(lock.pid), false)
        await until('the tab to leave', async () => !(await bare.topRows()).some((tab) => tab.root === rootC), NEXT_SCAN_MS)
        return `lock for pid ${lock.pid} on port ${lock.port} remained after SIGKILL, and the unnamed unselected tab left the list`
      })
    } finally {
      await bare.quit()
    }
    await check('settle', 'a warm start, the normal case: from the moment the lock is proven, no reconnect and no error toast', async () => {
      const root = makeProject(projects, 'warm-proj')
      const first = startUltimate(home, root, model.agentDir)
      await first.port()
      const warmup = await BareHub.launch(home, tempDir('data'))
      await until('the warm-up tab', async () => (await warmup.topRows()).some((tab) => tab.root === root), 5000)
      await warmup.toFront()
      while ((await warmup.topRows()).find((tab) => tab.selected)!.root !== root) {
        await warmup.switchTab()
        await sleep(100)
      }
      await until('the page', () => warmup.inShown('!!document.querySelector("#composer-input")'), 60000)
      await sleep(1000)
      await warmup.press(['Escape'])
      for (const digit of ['2', '3', '4', '1']) {
        await warmup.main(({ webContents }, digit) => webContents.getFocusedWebContents()!.sendInputEvent({ type: 'keyDown', keyCode: digit, modifiers: ['meta'] }), digit)
        await sleep(1000)
      }
      const log = join(projectHome(home, root), 'supervisor.log')
      await until('Vite to go quiet', () => {
        const last = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes(VITE_RELOAD)).at(-1)
        return !last || Date.now() - Date.parse(JSON.parse(last).at) > 6000
      }, 60000)
      await warmup.quit()
      await first.stop()
      const reloadsBefore = readFileSync(log, 'utf8').split(VITE_RELOAD).length

      const again = startUltimate(home, root, model.agentDir)
      running.set(root, again)
      const watcher = await BareHub.launch(home, tempDir('data'))
      await again.port()
      const provenAt = Date.now()
      await watcher.toFront()
      await until('a selected tab', async () => (await watcher.topRows()).some((tab) => tab.selected), 10000)
      while ((await watcher.topRows()).find((tab) => tab.selected)?.root !== root) {
        await watcher.switchTab()
        await sleep(50)
      }
      const seen = new Set<string>()
      let readings = 0
      try {
        while (Date.now() - provenAt < 15000) {
          const health = await Promise.race([watcher.inShown<Health>(READ_HEALTH), sleep(400).then(() => null)]).catch(() => null)
          if (health) {
            readings++
            seen.add(health.status ?? 'none yet')
            assert.deepEqual(health.toasts, [], 'no error toast at any moment')
            assert.notEqual(health.status, 'reconnecting…', 'no reconnect at any moment')
          }
          await sleep(100)
        }
        assert.ok(readings > 50, `${readings} readings`)
        assert.ok(seen.has('live'), `saw ${[...seen].join()}`)
        await waitForSettled(() => watcher.inShown<Health>(READ_HEALTH))
      } finally {
        await watcher.quit()
      }
      const reloadsAfter = readFileSync(log, 'utf8').split(VITE_RELOAD).length
      assert.equal(reloadsAfter, reloadsBefore, 'no Vite reload on a warm start')
      return `${readings} readings over 15 s from lock proof, status values ${[...seen].join(', ')}. No toast, no reconnect, no Vite reload.`
    })

    writeFileSync(join(EVIDENCE, 'real.json'), JSON.stringify(measured, null, 2))
  } finally {
    await hub.quit().catch(() => {})
    for (const instance of running.values()) await instance.stop()
    model.close()
  }
}
