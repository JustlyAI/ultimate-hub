import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, startStub, tempDir, until, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

type MenuItemShown = { label: string; accelerator: string | null; visible: boolean }

/** The zoom factor of each page view, and what each page renders at, as its pixel ratio over the sidebar's. */
const zooms = (hub: Hub) =>
  hub.evaluate(async ({ BaseWindow }) => {
    const [shell, ...pages] = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
    const base = (await shell.webContents.executeJavaScript('devicePixelRatio')) as number
    return {
      sidebar: { factor: shell.webContents.getZoomFactor(), ratio: base },
      pages: await Promise.all(
        pages.map(async (page) => ({
          url: page.webContents.getURL(),
          factor: Math.round(page.webContents.getZoomFactor() * 100) / 100,
          rendered: Math.round(((await page.webContents.executeJavaScript('devicePixelRatio')) / base) * 100) / 100,
        })),
      ),
    }
  }, null)

async function allAt(hub: Hub, zoom: number, count: number) {
  return until(`${count} pages at ${zoom}`, async () => {
    const { pages } = await zooms(hub)
    return pages.length === count && pages.every(({ factor, rendered }) => factor === zoom && rendered === zoom) ? pages : null
  }, 5000)
}

const viewMenu = (hub: Hub) =>
  hub.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find(({ label }) => label === 'View')!
    return view.submenu!.items.map(({ label, accelerator, visible }) => ({ label, accelerator: accelerator ?? null, visible }))
  }, null)

const clickViewItem = (hub: Hub, label: string) =>
  hub.evaluate(({ Menu }, label) => {
    const view = Menu.getApplicationMenu()!.items.find((item) => item.label === 'View')!
    view.submenu!.items.find((item) => item.label === label && item.visible)!.click()
  }, label)

/** Sibling test runs can take the active window, so a focus check first brings this Hub to the front. */
async function focus(hub: Hub, target: 'page' | 'sidebar') {
  await hub.evaluate(({ app, BaseWindow }, target) => {
    const window = BaseWindow.getAllWindows()[0]
    app.focus({ steal: true })
    window.focus()
    const [sidebar, ...pages] = window.contentView.children as Electron.WebContentsView[]
    ;(target === 'sidebar' ? sidebar : pages.find((page) => page.getVisible())!).webContents.focus()
  }, target)
  await until(`the ${target} has focus`, async () => (await hub.focusedUrl())?.startsWith(target === 'sidebar' ? 'file:' : 'http'))
}

const pageKeys = async (hub: Hub) => (await hub.shownPage()).evaluate(() => (window as unknown as { keys: string[] }).keys)
const sidebarWidth = (hub: Hub) => hub.shell().evaluate(() => Math.round(document.querySelector('#top')!.getBoundingClientRect().width))

export async function runZoomChecks(check: Check) {
  const section = 'zoom'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const userData = tempDir('data')
  const stubs: Record<string, Stub> = {}
  for (const name of ['alpha', 'beta']) stubs[name] = await startStub(home, join(projects, name))
  let hub = await Hub.launch(home, userData)
  const shot = async (name: string) => {
    await sleep(300)
    await hub.screenshot(join(EVIDENCE, name))
  }
  const open = async (label: string) => {
    await hub.select(label)
    const { port } = (await hub.tab(label))!
    await until(`${label} on screen`, async () => (await hub.shown()).visible[0]?.url.startsWith(`http://127.0.0.1:${port}/`))
  }
  try {
    await until('two tabs', async () => (await hub.topRows()).length === 2)
    await open('alpha')
    await open('beta')

    await check(section, 'the View menu holds Actual Size with no shortcut, Zoom In on ⌘+ and a hidden ⌘=, and Zoom Out on ⌘-', async () => {
      const items: MenuItemShown[] = await viewMenu(hub)
      assert.deepEqual(items, [
        { label: 'Hide Sidebar', accelerator: 'Shift+CommandOrControl+B', visible: true },
        { label: '', accelerator: null, visible: true },
        { label: 'Actual Size', accelerator: null, visible: true },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', visible: true },
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', visible: false },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', visible: true },
      ])
      const top = await hub.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map(({ label }) => label), null)
      assert.deepEqual(top.slice(1), ['Edit', 'View', 'Window'])
      await allAt(hub, 1, 2)
      await shot('zoom-1-before.png')
      return `menus ${top.join(', ')}. View: ${items.map(({ label, accelerator, visible }) => `${label} ${accelerator ?? 'none'}${visible ? '' : ' (hidden)'}`).join(', ')}. Both pages at 1.`
    })

    await check(section, 'with a page focused, Zoom In (menu item clicked from the main process) zooms every page, the sidebar stays at 1, and tabs.json saves the level', async () => {
      await focus(hub, 'page')
      const widthBefore = await sidebarWidth(hub)
      await clickViewItem(hub, 'Zoom In')
      const first = await allAt(hub, 1.1, 2)
      await clickViewItem(hub, 'Zoom In')
      await allAt(hub, 1.25, 2)
      const { sidebar } = await zooms(hub)
      assert.equal(sidebar.factor, 1)
      assert.equal(await sidebarWidth(hub), widthBefore)
      assert.ok((await hub.focusedUrl())?.startsWith('http'), 'the page keeps focus')
      await until('tabs.json zoom 1.25', () => hub.saved().zoom === 1.25)
      await shot('zoom-2-in-from-page.png')
      return `first Zoom In: ${JSON.stringify(first)}. Second: both pages at 1.25 by factor and by pixel ratio. Sidebar factor ${sidebar.factor}, top list ${widthBefore} px before and after. tabs.json zoom ${hub.saved().zoom}.`
    })

    await check(section, '⌘=, ⌘⇧=, and ⌘- reach the focused page and the focused sidebar with no preventDefault, so macOS can give them to the menu', async () => {
      const listen = `window.zoomKeys = []; window.addEventListener('keydown', (event) => {
        if (event.metaKey && !['Meta', 'Shift'].includes(event.key)) setTimeout(() => window.zoomKeys.push(event.code + (event.shiftKey ? '+shift' : '') + ' prevented=' + event.defaultPrevented))
      }, { capture: true }); true`
      const read = (target: { evaluate: (script: string) => Promise<unknown> }) => target.evaluate('window.zoomKeys') as Promise<string[]>
      const sends = [['=', ['meta']], ['=', ['meta', 'shift']], ['-', ['meta']]] as const
      const expected = ['Equal prevented=false', 'Equal+shift prevented=false', 'Minus prevented=false']
      const page = await hub.shownPage()
      await page.evaluate(listen)
      await focus(hub, 'page')
      for (const [key, modifiers] of sends) await hub.key(key, [...modifiers])
      const inPage = await until('three keys in the page', async () => ((await read(page)).length === 3 ? read(page) : null))
      await hub.shell().evaluate(listen)
      await focus(hub, 'sidebar')
      for (const [key, modifiers] of sends) await hub.key(key, [...modifiers])
      const inSidebar = await until('three keys in the sidebar', async () => ((await read(hub.shell())).length === 3 ? read(hub.shell()) : null))
      assert.deepEqual(inPage, expected)
      assert.deepEqual(inSidebar, expected)
      return `page heard ${inPage.join(', ')}. Sidebar heard ${inSidebar.join(', ')}. A key sent through sendInputEvent has no native event, so it cannot reach the macOS menu (measured), and this session has no Accessibility permission for real keys.`
    })

    await check(section, 'with the sidebar focused, Zoom Out (menu item clicked from the main process) zooms every page out, and the other page shows the level when selected', async () => {
      await focus(hub, 'sidebar')
      await clickViewItem(hub, 'Zoom Out')
      const pages = await allAt(hub, 1.1, 2)
      assert.equal((await zooms(hub)).sidebar.factor, 1)
      assert.ok((await hub.focusedUrl())?.startsWith('file:'), 'the sidebar keeps focus')
      await open('alpha')
      await until('tabs.json zoom 1.1', () => hub.saved().zoom === 1.1)
      await shot('zoom-3-out-from-sidebar-alpha.png')
      return `pages: ${JSON.stringify(pages)}. Sidebar factor 1. tabs.json zoom ${hub.saved().zoom}.`
    })

    await check(section, 'a link inside the page keeps the level', async () => {
      const page = await hub.shownPage()
      await page.locator('#same').click()
      await until('the second page', async () => (await hub.shown()).visible[0]?.url.endsWith('/second'))
      await sleep(300)
      const pages = await allAt(hub, 1.1, 2)
      return JSON.stringify(pages)
    })

    await check(section, '⌘0, ⌘B, ⌘K, and ⌘1…9 reach the page and leave the level alone, and no View item uses them', async () => {
      await open('beta')
      await focus(hub, 'page')
      const keys = ['0', 'B', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9']
      const before = (await pageKeys(hub)).length
      for (const key of keys) await hub.key(key, ['meta'])
      const seen = await until('all keys', async () => {
        const logged = (await pageKeys(hub)).slice(before)
        return logged.length >= keys.length ? logged : null
      })
      assert.deepEqual(seen, keys.map((key) => `Meta+${key.toLowerCase()}`))
      await sleep(300)
      await allAt(hub, 1.1, 2)
      return `the page saw ${seen.join(' ')}, and both pages stayed at 1.1`
    })

    await check(section, 'a new tab, and a page that opens again after its project stops, get the current level', async () => {
      stubs.gamma = await startStub(home, join(projects, 'gamma'))
      await until('gamma', () => hub.tab('gamma'))
      await open('gamma')
      const three = await allAt(hub, 1.1, 3)
      await shot('zoom-4-new-tab.png')
      await hub.rename('alpha', 'Website')
      await until('Website', () => hub.tab('Website'))
      await stubs.alpha.stop()
      await until('alpha view closed', async () => (await hub.shown()).pages === 2)
      stubs.alpha = await startStub(home, stubs.alpha.root)
      await until('Website live again', async () => (await hub.tab('Website'))?.port === stubs.alpha.port)
      await open('Website')
      const back = await allAt(hub, 1.1, 3)
      return `new tab gamma: ${JSON.stringify(three.find(({ url }) => url.includes(String(stubs.gamma.port))))}. Website reopened on port ${stubs.alpha.port}: ${JSON.stringify(back.find(({ url }) => url.includes(String(stubs.alpha.port))))}.`
    })

    await check(section, 'the level survives a Hub restart, also on a project that Chromium has never zoomed', async () => {
      await hub.quit()
      stubs.delta = await startStub(home, join(projects, 'delta'))
      hub = await Hub.launch(home, userData)
      await until('four tabs', async () => (await hub.topRows()).length === 4)
      await open('Website')
      await open('beta')
      await open('delta')
      const pages = await allAt(hub, 1.1, 3)
      assert.equal((await zooms(hub)).sidebar.factor, 1)
      await shot('zoom-5-after-restart-new-project.png')
      return `after relaunch: ${JSON.stringify(pages)}, tabs.json zoom ${hub.saved().zoom}. delta started while the Hub was closed.`
    })

    await check(section, 'the saved zoom wins over the level that Chromium remembers for a project', async () => {
      await hub.quit()
      const file = join(userData, 'tabs.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), zoom: 1.5 }))
      hub = await Hub.launch(home, userData)
      await until('four tabs', async () => (await hub.topRows()).length === 4)
      await open('Website')
      await open('beta')
      const pages = await allAt(hub, 1.5, 2)
      return `Chromium last saw 1.1 on these projects. With zoom 1.5 written to tabs.json while the Hub was closed: ${JSON.stringify(pages)}`
    })

    await check(section, 'Actual Size (menu item clicked from the main process) sets every page to 1, and Zoom In from the same menu works', async () => {
      await clickViewItem(hub, 'Actual Size')
      await allAt(hub, 1, 2)
      assert.equal((await zooms(hub)).sidebar.factor, 1)
      await until('tabs.json zoom 1', () => hub.saved().zoom === 1)
      await shot('zoom-6-actual-size.png')
      await clickViewItem(hub, 'Zoom In')
      await allAt(hub, 1.1, 2)
      await clickViewItem(hub, 'Zoom Out')
      await allAt(hub, 1, 2)
      return `Actual Size gave 1 on both pages and in tabs.json. Zoom In gave 1.1, Zoom Out gave 1.`
    })

    await check(section, 'the level stops at 500% and 25%', async () => {
      for (let press = 0; press < 20; press++) await clickViewItem(hub, 'Zoom In')
      await allAt(hub, 5, 2)
      for (let press = 0; press < 20; press++) await clickViewItem(hub, 'Zoom Out')
      await allAt(hub, 0.25, 2)
      await clickViewItem(hub, 'Actual Size')
      await allAt(hub, 1, 2)
      return '20 Zoom In stopped at 5, 20 Zoom Out stopped at 0.25'
    })
  } finally {
    await hub.quit().catch(() => hub.forceStop())
  }

  await check(section, 'a tabs.json without zoom opens at actual size and keeps its names', async () => {
    const data = tempDir('data')
    writeFileSync(join(data, 'tabs.json'), JSON.stringify({ groups: [], tabs: [{ root: stubs.beta.root, name: 'Docs', groupId: null }] }))
    const old = await Hub.launch(home, data)
    try {
      await until('Docs', () => old.tab('Docs'))
      await old.select('Docs')
      const pages = await allAt(old, 1, 1)
      assert.equal(old.log(), '')
      return `Docs showed with its name, ${JSON.stringify(pages)}, and hub.log is empty`
    } finally {
      await old.quit()
    }
  })
  for (const stub of Object.values(stubs)) await stub.stop()
}
