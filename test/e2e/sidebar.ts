import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RAIL_WIDTH, SIDEBAR_WIDTH } from '../../src/shared/tabs.ts'
import { sleep, startStub, tempDir, until, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

// Lengths like real folder names. "document-review" did not fit at the old 220 px.
const NAMES = ['document-review', 'ultimate-notes', 'monorepo', 'transcription-menubar']

/** Every visible top row whose label is cut, with the widths that cut it. */
const cutLabels = (hub: Hub) =>
  hub.shell().evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#top .tab')]
      .filter((row) => row.offsetParent !== null)
      .map((row) => row.querySelector<HTMLElement>('.label')!)
      .filter((label) => label.scrollWidth > label.clientWidth)
      .map((label) => `${label.textContent} ${label.scrollWidth}>${label.clientWidth}`),
  )

const toggleBox = (hub: Hub) =>
  hub.shell().evaluate(() => {
    const { x, y, width, height } = document.querySelector('#sidebar-toggle')!.getBoundingClientRect()
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  })

const shellState = (hub: Hub) =>
  hub.shell().evaluate(() => {
    const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!
    const visible = (selector: string) => document.querySelector<HTMLElement>(selector)!.offsetParent !== null
    return {
      width: Math.round(document.querySelector('#sidebar')!.getBoundingClientRect().width),
      label: toggle.ariaLabel,
      expanded: toggle.ariaExpanded,
      lists: visible('#top') || visible('#status'),
      title: visible('#top-title'),
    }
  })

const control = (stub: Stub, value: object) => fetch(`http://127.0.0.1:${stub.port}/status-control`, { method: 'POST', body: JSON.stringify(value) })
const asking = { result: { questions: { count: 1 }, busy: 0, failures: [], extensions: [] } }
const working = { result: { questions: { count: 0 }, busy: 1, failures: [], extensions: [] } }

/** Each rail item as text: `[caption]`, or the initials, short name, dot, count, and selection of a tile. */
const railItems = (hub: Hub) =>
  hub.shell().evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#rail > li')].map((item) =>
      item.classList.contains('rail-caption')
        ? `[${item.textContent}]`
        : [
            item.querySelector('.face')!.firstChild!.textContent,
            item.querySelector('.short')!.textContent,
            item.querySelector('.dot')?.classList[1] ?? 'no-dot',
            item.querySelector('.count')?.textContent ?? '',
            item.ariaSelected === 'true' ? 'selected' : '',
          ]
            .filter(Boolean)
            .join(' '),
    ),
  )

const railEdges = (hub: Hub) =>
  hub.shell().evaluate(() => ({
    above: document.querySelector<HTMLElement>('#rail-above')!.hidden ? '' : document.querySelector('#rail-above')!.textContent,
    below: document.querySelector<HTMLElement>('#rail-below')!.hidden ? '' : document.querySelector('#rail-below')!.textContent,
  }))

const railTile = (hub: Hub, short: string) => hub.shell().locator('#rail .rail-tile', { has: hub.shell().locator(`.short:text-is("${short}")`) })

const viewMenuFirst = (hub: Hub) =>
  hub.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.items.find(({ label }) => label === 'View')!.submenu!.items[0]
    return { label: item.label, accelerator: item.accelerator ?? null }
  }, null)

/** The visible page and the shown terminal both start at `left` and fill the rest of the window. */
async function viewsAt(hub: Hub, left: number) {
  return until(`views at x=${left}`, async () => {
    const [width] = await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentSize(), null)
    const pages = (await hub.shown()).visible
    const terminals = (await hub.terminalViews()).filter(({ visible }) => visible).map(({ bounds }) => bounds)
    const all = [...pages, ...terminals]
    return all.length > 0 && all.every((view) => view.x === left && view.width === width - left) ? { pages, terminals } : null
  }, 3000)
}

const pageKeys = async (hub: Hub) => (await hub.shownPage()).evaluate(() => (window as unknown as { keys: string[] }).keys)

async function focusPage(hub: Hub) {
  await hub.evaluate(({ app, BaseWindow }) => {
    const window = BaseWindow.getAllWindows()[0]
    app.focus({ steal: true })
    window.focus()
    const pages = (window.contentView.children as Electron.WebContentsView[]).filter((view) => view.webContents.getURL().startsWith('http'))
    pages.find((page) => page.getVisible())!.webContents.focus()
  }, null)
  await until('the page has focus', async () => (await hub.focusedUrl())?.startsWith('http'))
}

export async function runSidebarChecks(check: Check) {
  const section = 'sidebar'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const userData = tempDir('data')
  const stubs: Stub[] = []
  for (const name of NAMES) {
    // The shell starts in the project folder, so it must exist.
    mkdirSync(join(projects, name), { recursive: true })
    stubs.push(await startStub(home, join(projects, name)))
  }
  let hub = await Hub.launch(home, userData)
  const shot = async (name: string) => {
    await sleep(300)
    await hub.screenshot(join(EVIDENCE, name))
  }
  try {
    await until('four tabs', async () => (await hub.topRows()).length === NAMES.length)
    await hub.select('document-review')
    await until('a page', () => hub.shownPage())

    await check(section, `at ${SIDEBAR_WIDTH} px the longest names fit beside the port, pause, and ⋯, also in a group and when selected`, async () => {
      const ungrouped = await cutLabels(hub)
      await hub.planMenus(['Group'])
      await hub.shell().locator('#add').click()
      await hub.shell().locator('#name-input').fill('Research')
      await hub.shell().locator('#name-ok').click()
      await until('the group', () => hub.groupHeader('Research').count())
      for (const name of ['document-review', 'transcription-menubar']) {
        await hub.planMenus(['Research'])
        await hub.topRow(name).click({ button: 'right' })
        await until(`${name} in the group`, async () => (await hub.topNames()).find(([, labels]) => labels.includes(name))?.[0] === 'Research')
      }
      await hub.select('document-review')
      const grouped = await cutLabels(hub)
      await shot('sidebar-1-full.png')
      assert.deepEqual({ ungrouped, grouped }, { ungrouped: [], grouped: [] })
      const { width } = await shellState(hub)
      assert.equal(width, SIDEBAR_WIDTH)
      return `No label was cut, ungrouped or in a group, with document-review selected. Sidebar ${width} px. Screenshot sidebar-1-full.png`
    })

    await check(section, 'the top row holds the window buttons, the logo, the name, and the terminal, search, and sidebar buttons, and moves the window', async () => {
      const lights = await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getWindowButtonPosition(), null)
      const row = await hub.shell().evaluate(() => {
        const brand = document.querySelector<HTMLElement>('#brand')!
        const region = (element: Element) => getComputedStyle(element).getPropertyValue('app-region')
        return {
          height: brand.getBoundingClientRect().height,
          logoX: Math.round(document.querySelector('#logo')!.getBoundingClientRect().x),
          name: brand.querySelector('h1')!.textContent,
          buttons: [...brand.querySelectorAll('button')].map((button) => button.id),
          drag: region(brand),
          buttonDrag: [...new Set([...brand.querySelectorAll('button')].map(region))],
        }
      })
      assert.deepEqual(lights, { x: 14, y: 13 })
      assert.deepEqual(row, { height: 40, logoX: 78, name: 'Ultimate Hub', buttons: ['terminal-toggle', 'search-open', 'sidebar-toggle'], drag: 'drag', buttonDrag: ['no-drag'] })
      return `Window buttons at ${JSON.stringify(lights)}. Top row ${JSON.stringify(row)}`
    })

    await check(section, 'a click on the sidebar button leaves a rail with the window buttons and that button under them, moves the page, and saves the form', async () => {
      await hub.shell().locator('#sidebar-toggle').click()
      const views = await viewsAt(hub, RAIL_WIDTH)
      const state = await shellState(hub)
      assert.deepEqual(state, { width: RAIL_WIDTH, label: 'Show sidebar', expanded: 'false', lists: false, title: false })
      const inRail = await toggleBox(hub)
      assert.ok(inRail.y >= 40 && inRail.y <= 50 && inRail.x >= 0 && inRail.x + inRail.width <= RAIL_WIDTH, `the button is under the window buttons, in the rail: ${JSON.stringify(inRail)}`)
      assert.equal(await hub.focusedInShell(), 'sidebar-toggle', 'the button keeps the keyboard')
      assert.deepEqual(await viewMenuFirst(hub), { label: 'Show Sidebar', accelerator: 'Shift+CommandOrControl+B' })
      await until('tabs.json rail', () => hub.saved().sidebar === 'rail')
      await shot('sidebar-2-rail.png')
      await hub.shell().locator('#sidebar-toggle').click()
      await viewsAt(hub, SIDEBAR_WIDTH)
      assert.equal((await shellState(hub)).lists, true)
      const full = await toggleBox(hub)
      assert.ok(full.y < 40 && full.x + full.width <= SIDEBAR_WIDTH, 'the button is back in the top row')
      return `In the rail the button was at ${JSON.stringify(inRail)}, and back at ${JSON.stringify(full)}. The page went to x=${views.pages[0].x}, width ${views.pages[0].width}. View menu: Show Sidebar. A second click brought the lists back. Screenshot sidebar-2-rail.png`
    })

    await check(section, 'the rail shows each tab as a tile with its initials, short name, and status, a collapsed group as one tile with a menu, and a marker for an urgent tile out of view', async () => {
      await control(stubs[0], asking)
      await control(stubs[2], working)
      await hub.shell().locator('#sidebar-toggle').click()
      await viewsAt(hub, RAIL_WIDTH)
      const tiles = await until('the status dots', async () => {
        const items = await railItems(hub)
        return items.some((item) => item.includes('needs-you')) && items.some((item) => item.includes('working')) ? items : null
      }, 15000)
      assert.deepEqual(tiles, [
        '[Research]',
        'DR document-review needs-you selected',
        'TM transcription-menubar no-dot',
        '[]',
        'Mo monorepo working',
        'UN ultimate-notes no-dot',
      ])
      await shot('sidebar-4-rail-tiles.png')

      await railTile(hub, 'monorepo').click()
      await until('monorepo selected', async () => (await hub.tab('monorepo'))?.selected)
      await until('the page of the clicked tile', async () => (await hub.shown()).visible.some(({ url }) => url.includes(`:${stubs[2].port}/`)))

      await hub.shell().locator('#sidebar-toggle').click()
      await hub.groupHeader('Research').locator('.toggle').click()
      await hub.shell().locator('#sidebar-toggle').click()
      await viewsAt(hub, RAIL_WIDTH)
      const stacked = await until('one tile for Research', async () => {
        const items = await railItems(hub)
        return items[0] === 'Re Research needs-you 2' ? items : null
      })
      await shot('sidebar-5-rail-stack.png')
      await hub.planMenus(['transcription-menubar'])
      await railTile(hub, 'Research').focus()
      await hub.shell().keyboard.press('Enter')
      await until('transcription-menubar selected', async () => (await hub.tab('transcription-menubar'))?.selected)
      const menu = (await hub.menusShown()).at(-1)!.items.map(({ label, checked }) => `${label}${checked ? ' ✓' : ''}`)
      assert.deepEqual(menu, ['document-review · Needs You', 'transcription-menubar'])
      const revealed = await until('Research open again', async () => {
        const items = await railItems(hub)
        return items[0] === '[Research]' ? items.slice(0, 3) : null
      })
      assert.deepEqual(revealed, ['[Research]', 'DR document-review needs-you', 'TM transcription-menubar no-dot selected'], 'a selection reveals its tab, as in the full sidebar')
      const pickedFocus = await until('the chosen tile has the keyboard', async () => {
        const focus = await hub.focusedInShell()
        return focus.startsWith('rail:') ? focus : null
      })
      assert.ok(pickedFocus.endsWith('/transcription-menubar'), pickedFocus)
      await shot('sidebar-6-rail-picked.png')

      const extra: Stub[] = []
      for (const name of ['alpha-one', 'beta-two', 'gamma-three', 'delta-four']) {
        mkdirSync(join(projects, name), { recursive: true })
        extra.push(await startStub(home, join(projects, name)))
      }
      await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1000, 400), null)
      await until('eight tiles', async () => (await railItems(hub)).filter((item) => !item.startsWith('[')).length === 8)
      await hub.shell().locator('#rail').evaluate((list) => list.scrollTo(0, list.scrollHeight))
      const scrolled = await until('a marker above', async () => ((await railEdges(hub)).above ? railEdges(hub) : null))
      assert.deepEqual(scrolled, { above: '↑ 1', below: '' })
      await shot('sidebar-7-rail-marker.png')
      await hub.shell().locator('#rail-above button').click()
      const after = await until('no marker', async () => {
        const edges = await railEdges(hub)
        return edges.above === '' ? edges : null
      })
      assert.ok(await railTile(hub, 'document-review').isVisible(), 'the marker scrolled to the tile')
      assert.ok((await hub.focusedInShell()).endsWith('/document-review'), 'the tile has the keyboard')

      await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1400, 900), null)
      for (const stub of extra) await stub.stop()
      await control(stubs[0], {})
      await control(stubs[2], {})
      await hub.shell().locator('#sidebar-toggle').click()
      await viewsAt(hub, SIDEBAR_WIDTH)
      await until('four tabs', async () => (await hub.topRows()).length === NAMES.length)
      return `Tiles ${JSON.stringify(tiles)}. A click on monorepo showed its page. Enter on the stacked tile, then a pick, left the keyboard on ${pickedFocus}. Collapsed: ${JSON.stringify(stacked)}, menu ${JSON.stringify(menu)}, after the pick ${JSON.stringify(revealed)}. At 400 px, scrolled to the end: ${JSON.stringify(scrolled)}, after the click ${JSON.stringify(after)}. Screenshots sidebar-4 to sidebar-7`
    })

    await check(section, '⇧⌘B toggles from the page, which keeps the keyboard and never sees the key, while ⌘B still reaches the page', async () => {
      await focusPage(hub)
      const before = (await pageKeys(hub)).length
      await hub.key('B', ['meta', 'shift'])
      await viewsAt(hub, RAIL_WIDTH)
      await hub.key('B', ['meta'])
      await hub.key('B', ['meta', 'shift'])
      await viewsAt(hub, SIDEBAR_WIDTH)
      await hub.key('K', ['meta'])
      const seen = await until('the page saw its keys', async () => {
        const keys = (await pageKeys(hub)).slice(before)
        return keys.includes('Meta+k') ? keys : null
      })
      assert.deepEqual(seen, ['Meta+b', 'Meta+k'])
      assert.ok((await hub.focusedUrl())?.startsWith('http'), 'the page keeps focus')
      assert.equal((await shellState(hub)).width, SIDEBAR_WIDTH, 'one press is one toggle')
      return `two presses of ⇧⌘B went rail and back. The page saw only ${seen.join(' ')} and kept focus.`
    })

    await check(section, '⇧⌘B from a focused row moves the keyboard to the button, and from the terminal it moves the shell too', async () => {
      await hub.topRow('monorepo').focus()
      await hub.keyTo('sidebar', 'B', ['meta', 'shift'])
      await until('rail', async () => (await shellState(hub)).width === RAIL_WIDTH)
      assert.equal(await hub.focusedInShell(), 'sidebar-toggle')
      await hub.keyTo('sidebar', 'B', ['meta', 'shift'])
      await until('full', async () => (await shellState(hub)).width === SIDEBAR_WIDTH)
      await focusPage(hub)
      await hub.keyTo('page', '`', ['control'])
      const term = await hub.terminalPage()
      await until('the terminal has focus', async () => (await hub.terminalViews()).some(({ visible, focused }) => visible && focused))
      await hub.keyTo('terminal', 'B', ['meta', 'shift'])
      const { terminals } = await viewsAt(hub, RAIL_WIDTH)
      assert.ok(await term.evaluate(() => document.hasFocus()), 'the terminal keeps the keyboard')
      await shot('sidebar-3-rail-terminal.png')
      await hub.keyTo('terminal', 'B', ['meta', 'shift'])
      await viewsAt(hub, SIDEBAR_WIDTH)
      await hub.keyTo('terminal', '`', ['control'])
      return `the row's press left focus on the button. With the shell shown, ⇧⌘B moved it to x=${terminals[0].x}, width ${terminals[0].width}. Screenshot sidebar-3-rail-terminal.png`
    })

    await check(section, 'the rail stays after a quit and a new launch', async () => {
      await hub.shell().locator('#sidebar-toggle').click()
      await until('tabs.json rail', () => hub.saved().sidebar === 'rail')
      await hub.quit()
      hub = await Hub.launch(home, userData)
      await until('four tabs', async () => (await hub.topRows()).length === NAMES.length)
      // The rail hides the rows, so Ctrl+Tab selects a tab.
      await hub.keyTo('sidebar', 'Tab', ['control'])
      await viewsAt(hub, RAIL_WIDTH)
      assert.equal((await shellState(hub)).width, RAIL_WIDTH)
      assert.deepEqual(await viewMenuFirst(hub), { label: 'Show Sidebar', accelerator: 'Shift+CommandOrControl+B' })
      return `the next launch opened with the rail, the page at x=${RAIL_WIDTH}, and Show Sidebar in the View menu`
    })
  } finally {
    await hub.quit()
    for (const stub of stubs) await stub.stop()
  }
}
