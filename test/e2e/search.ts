import assert from 'node:assert/strict'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, sleep, startScriptedModel, startStub, startUltimate, tempDir, until, type RealUltimate, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { settled, showProject } from './real.ts'

const NEXT_SCAN_MS = 2500
const ANNOUNCE_MS = 500
const FILLERS = Array.from({ length: 24 }, (_, index) => `filler-${String(index + 1).padStart(2, '0')}`)

type ResultShown = { root: string; name: string; detail: string; marks: string[]; active: boolean }
type PanelShown = {
  open: boolean
  query: string
  focused: string
  heading: string
  results: ResultShown[]
  empty: string | null
  spoken: string
  activeDescendant: string | null
  markStyle: { weight: string; line: string } | null
}

const panel = (hub: Hub): Promise<PanelShown> =>
  hub.shell().evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('#search')!
    const input = document.querySelector<HTMLInputElement>('#search-input')!
    const empty = document.querySelector<HTMLElement>('#search-empty')!
    const mark = document.querySelector('#search mark')
    return {
      open: dialog.open,
      query: input.value,
      focused: document.activeElement?.id ?? '',
      heading: document.querySelector('#search-title')!.textContent!,
      results: [...document.querySelectorAll<HTMLElement>('#search-results li')].map((item) => ({
        root: item.dataset.root!,
        name: item.querySelector('.result-name')!.textContent!,
        detail: item.querySelector('.result-detail')!.textContent!,
        marks: [...item.querySelectorAll('mark')].map((element) => element.textContent!),
        active: item.ariaSelected === 'true',
      })),
      empty: empty.hidden ? null : empty.textContent,
      spoken: document.querySelector('#search-count')!.textContent!,
      activeDescendant: input.getAttribute('aria-activedescendant'),
      markStyle: mark ? { weight: getComputedStyle(mark).fontWeight, line: getComputedStyle(mark).textDecorationLine } : null,
    }
  })

/** 'shell' or 'page' for each view, bottom first. */
const viewOrder = (hub: Hub) =>
  hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].contentView.children.map((view) => ((view as Electron.WebContentsView).webContents.getURL().startsWith('file:') ? 'shell' : 'page')), null)

const shellFocused = (hub: Hub) => hub.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL().startsWith('file:') ?? false, null)

/** Types into the view that has the keyboard, through the browser process, as the keyboard would. */
const typeKeys = (hub: Hub, text: string) =>
  hub.evaluate(({ webContents }, text) => {
    const focused = webContents.getFocusedWebContents()
    if (!focused) throw new Error('no view has focus')
    for (const keyCode of text) {
      focused.sendInputEvent({ type: 'keyDown', keyCode })
      focused.sendInputEvent({ type: 'char', keyCode })
      focused.sendInputEvent({ type: 'keyUp', keyCode })
    }
  }, text)

const openByKey = async (hub: Hub) => {
  await hub.key('F', ['meta', 'shift'])
  await until('search open with the keyboard in its field', async () => {
    const { open, focused, query } = await panel(hub)
    return open && focused === 'search-input' && query === '' && (await shellFocused(hub))
  }, 3000)
}

const search = async (hub: Hub, query: string) => {
  await hub.shell().locator('#search-input').fill('')
  await typeKeys(hub, query)
  await until(`the query "${query}"`, async () => (await panel(hub)).query === query, 3000)
  return (await panel(hub)).results
}

const closeByEscape = async (hub: Hub) => {
  await hub.key('Escape')
  await until('search closed and the shell under the pages', async () => !(await panel(hub)).open && (await viewOrder(hub))[0] === 'shell', 3000)
}

const selectedRoot = (hub: Hub) => hub.shell().evaluate(() => document.querySelector<HTMLElement>('#top .tab[aria-selected="true"]')?.dataset.root ?? null)
const pageRoot = async (hub: Hub) => (await hub.shownPage()).evaluate(() => document.body.dataset.root ?? document.title)
const brief = (results: ResultShown[]) => results.map(({ name, detail }) => `${name} (${detail.split(' · ')[0]})`).join(', ')

export async function runSearchChecks(check: Check) {
  const section = 'search'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const userData = tempDir('data')
  const model = await startScriptedModel()
  const stubs: Record<string, Stub> = {}
  const start = async (key: string, path: string) => (stubs[key] = await startStub(home, join(projects, path)))
  await start('billing', 'clients/billing')
  await start('clientSite', 'clients/site')
  await start('sitekit', 'tools/sitekit')
  await start('alpha', 'alpha')
  await start('otherSite', 'other/site')
  for (const filler of FILLERS) await start(filler, filler)
  const realRoot = makeProject(projects, 'real-proj')
  const stoppedRoot = join(projects, 'stopped')
  const root = (key: string) => stubs[key].root
  mkdirSync(userData, { recursive: true })
  const tab = (path: string, groupId: string | null, name: string | null = null) => ({ root: path, name, groupId })
  writeFileSync(
    join(userData, 'tabs.json'),
    JSON.stringify({
      groups: [
        { id: 'clients', name: 'Clients', collapsed: true },
        { id: 'tools', name: 'Tools', collapsed: false },
      ],
      tabs: [
        tab(root('billing'), 'clients'),
        tab(root('clientSite'), 'clients'),
        tab(root('sitekit'), 'tools', 'Site Kit'),
        tab(stoppedRoot, 'tools', 'Stopped Named'),
        tab(root('alpha'), null),
        tab(root('otherSite'), null),
        tab(realRoot, null),
        ...FILLERS.map((filler) => tab(root(filler), null)),
      ],
    }),
  )
  let real: RealUltimate | undefined
  const hub = await Hub.launch(home, userData)
  const shot = async (name: string) => {
    await sleep(300)
    await hub.screenshot(join(EVIDENCE, name))
  }
  const liveRoots = async () => {
    const stopped = new Set([stoppedRoot])
    return (await hub.topRoots()).filter((candidate) => !stopped.has(candidate))
  }
  try {
    real = startUltimate(home, realRoot, model.agentDir)
    await until('every live tab', async () => (await hub.topRoots()).length === FILLERS.length + 7, 60000)
    const realPage = await showProject(hub, 'real-proj', realRoot)
    await settled(home, realRoot, realPage)

    await check(section, 'entry: the search icon in the top row, between the terminal and sidebar buttons, has its name and the shortcut in its tooltip, opens the panel with focus in the field, and Escape returns focus to it', async () => {
      const button = hub.shell().locator('#search-open')
      assert.equal(await button.getAttribute('aria-label'), 'Search running instances')
      assert.ok((await button.getAttribute('title'))!.includes('⌘⇧F'))
      const box = (selector: string) => hub.shell().locator(selector).boundingBox().then((found) => found!)
      const [terminalBox, searchBox, toggleBox] = await Promise.all(['#terminal-toggle', '#search-open', '#sidebar-toggle'].map(box))
      assert.ok(terminalBox.x + terminalBox.width <= searchBox.x && searchBox.x + searchBox.width <= toggleBox.x, 'terminal, search, then the sidebar button')
      assert.ok([terminalBox, toggleBox].every(({ y }) => Math.abs(y - searchBox.y) < 4) && searchBox.y < 40, 'all three in the top row')
      await button.click()
      await until('search open', async () => (await panel(hub)).focused === 'search-input', 3000)
      const shown = await panel(hub)
      assert.equal(shown.heading, 'Search running instances')
      assert.equal((await viewOrder(hub)).at(-1), 'shell')
      await closeByEscape(hub)
      assert.equal(await hub.focusedInShell(), 'search-open')
      assert.ok(await shellFocused(hub))
      return `Tooltip "${await button.getAttribute('title')}". A click opened "${shown.heading}" with focus in the field and the shell above the page. Escape closed it, and focus was on the icon.`
    })

    await check(section, 'Cmd+Shift+F from the sidebar opens the panel above the page view, it gets the typing, and Escape returns focus to the row', async () => {
      const selected = (await selectedRoot(hub))!
      await hub.shell().locator(`#top .tab[data-root="${selected}"]`).focus()
      await until('the shell has the keyboard', () => shellFocused(hub))
      await openByKey(hub)
      const order = await viewOrder(hub)
      assert.equal(order.at(-1), 'shell')
      const results = await search(hub, 'alpha')
      assert.deepEqual(results.map(({ root }) => root), [root('alpha')])
      await shot('search-01-from-sidebar.png')
      await closeByEscape(hub)
      assert.equal(await hub.focusedInShell(), `row:${selected}`)
      assert.equal(await selectedRoot(hub), selected)
      return `View order while open, bottom first: ${order.join(', ')}. Typed "alpha" through the browser process, and the panel listed ${brief(results)}. Escape put the shell back under the page, and focus was on the selected row. Screenshot search-01-from-sidebar.png`
    })

    await check(section, 'Cmd+Shift+F from a focused page opens the panel, the page gets none of the keys, and Escape gives the page the keyboard again', async () => {
      await hub.select('alpha')
      const page = await until('alpha page', async () => ((await pageRoot(hub)) === root('alpha') ? hub.shownPage() : null), 15000)
      await hub.evaluate(({ BaseWindow }) => {
        const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
        views.find((view) => !view.webContents.getURL().startsWith('file:') && view.getVisible())!.webContents.focus()
      }, null)
      await until('the page has the keyboard', async () => (await hub.focusedUrl()) === `http://127.0.0.1:${stubs.alpha.port}/`)
      await page.evaluate(() => ((window as unknown as { keys: string[] }).keys = []))
      await openByKey(hub)
      const order = await viewOrder(hub)
      assert.equal(order.at(-1), 'shell')
      const results = await search(hub, 'kit')
      await shot('search-02-over-page.png')
      await closeByEscape(hub)
      assert.equal(await hub.focusedUrl(), `http://127.0.0.1:${stubs.alpha.port}/`)
      const keys = await page.evaluate(() => (window as unknown as { keys: string[] }).keys)
      assert.deepEqual(keys, [], 'the page got no key')
      return `From alpha's page: the panel opened above it (${order.join(', ')}), and "kit" gave ${brief(results)}. The page recorded no key event. After Escape, alpha's page had the keyboard. Screenshot search-02-over-page.png`
    })

    await check(section, 'from the composer of a real Ultimate, the panel gets the typing; Escape keeps the page, the draft, the caret, the groups, and the selection', async () => {
      const page = await showProject(hub, 'real-proj', realRoot)
      const composer = page.locator('#composer-input')
      await composer.click()
      await composer.fill('draft kept')
      await until('the composer has the keyboard', async () => (await hub.focusedUrl())?.startsWith('http') && (await page.evaluate(() => document.activeElement?.id)) === 'composer-input')
      const before = { top: await hub.topList(), shown: (await hub.shown()).visible.map(({ id, url }) => ({ id, url })), selected: await selectedRoot(hub) }
      await openByKey(hub)
      const results = await search(hub, 'real')
      assert.deepEqual(results.map(({ root }) => root), [realRoot])
      assert.equal(await composer.inputValue(), 'draft kept', 'the typing went to the panel, not the composer')
      await shot('search-03-over-real-page.png')
      await closeByEscape(hub)
      await until('the page has the keyboard', async () => (await hub.focusedUrl())?.startsWith('http'), 3000)
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'composer-input')
      await typeKeys(hub, '!')
      await until('the next key in the composer', async () => (await composer.inputValue()) === 'draft kept!', 3000)
      assert.deepEqual(
        { top: await hub.topList(), shown: (await hub.shown()).visible.map(({ id, url }) => ({ id, url })), selected: await selectedRoot(hub) },
        before,
      )
      await composer.fill('')
      return `The panel listed ${brief(results)} while the composer kept "draft kept". After Escape, the composer had focus, and the next key gave "draft kept!". The top list, the page view id and address, and the selection were the same. Screenshot search-03-over-real-page.png`
    })

    await check(section, 'Cmd+F, Cmd+K, and Cmd+1 reach the page, and search does not open', async () => {
      await hub.select('alpha')
      const page = await until('alpha page', async () => ((await pageRoot(hub)) === root('alpha') ? hub.shownPage() : null), 15000)
      await until('the page has the keyboard', async () => (await hub.focusedUrl()) === `http://127.0.0.1:${stubs.alpha.port}/`)
      await page.evaluate(() => ((window as unknown as { keys: string[] }).keys = []))
      for (const key of ['F', 'K', '1']) await hub.key(key, ['meta'])
      await until('three keys in the stub page', async () => (await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).length === 3, 3000)
      const stubKeys = await page.evaluate(() => (window as unknown as { keys: string[] }).keys)
      assert.equal((await panel(hub)).open, false)
      const realPage = await showProject(hub, 'real-proj', realRoot)
      await until('the real page has the keyboard', async () => (await hub.focusedUrl())?.startsWith('http'))
      await hub.key('K', ['meta'])
      const palette = realPage.locator('[cmdk-root]')
      await palette.waitFor({ timeout: 5000 })
      assert.equal((await panel(hub)).open, false)
      await shot('search-04-cmd-k-palette.png')
      await realPage.keyboard.press('Escape')
      await palette.waitFor({ state: 'detached', timeout: 5000 })
      return `The stub page recorded ${JSON.stringify(stubKeys)}. In the real Ultimate, Cmd+K opened its palette. Search stayed closed for all of them. Screenshot search-04-cmd-k-palette.png`
    })

    await check(section, 'names, paths, and group names match in mixed case and across fields, in the same order each time, and marks do not rely on color alone', async () => {
      await openByKey(hub)
      const site = await search(hub, 'SITE')
      const again = await search(hub, 'SITE')
      assert.deepEqual(again, site)
      assert.deepEqual(site.map(({ root }) => root), [root('clientSite'), root('otherSite'), root('sitekit')], 'two full name matches in sidebar order, then the prefix match')
      const style = (await panel(hub)).markStyle!
      assert.ok(Number(style.weight) >= 700 && style.line.includes('underline'), JSON.stringify(style))
      assert.deepEqual(site[0].marks, ['site', 'site'])
      const mixed = await search(hub, 'kit TOOLS')
      assert.deepEqual(mixed.map(({ root }) => root), [root('sitekit')])
      assert.ok(mixed[0].marks.includes('Kit') && mixed[0].marks.includes('Tools'), JSON.stringify(mixed[0].marks))
      const group = await search(hub, 'clients')
      assert.deepEqual(group.map(({ root }) => root), [root('billing'), root('clientSite')])
      const path = await search(hub, 'other/')
      assert.deepEqual(path.map(({ root }) => root), [root('otherSite')])
      await search(hub, 'SITE')
      await shot('search-05-marks.png')
      await closeByEscape(hub)
      return `"SITE" (twice, same order): ${brief(site)}. Marks are bold (${style.weight}) and ${style.line}. "kit TOOLS": ${brief(mixed)}, marks ${JSON.stringify(mixed[0].marks)}. "clients": ${brief(group)}. "other/": ${brief(path)}. Screenshot search-05-marks.png`
    })

    await check(section, 'a tab in a collapsed group shows, the group stays collapsed while it shows, and selecting it reveals its top row and focuses its page', async () => {
      await openByKey(hub)
      const results = await search(hub, 'billing')
      assert.deepEqual(results.map(({ root, detail }) => [root, detail.split(' · ')[0]]), [[root('billing'), 'Clients']])
      const clients = (await hub.topList()).find(({ name }) => name === 'Clients')!
      assert.equal(clients.collapsed, true)
      await shot('search-06-collapsed-group.png')
      await hub.key('Enter')
      await until('search closed', async () => !(await panel(hub)).open, 3000)
      await until('billing selected', async () => (await selectedRoot(hub)) === root('billing'), 3000)
      assert.equal((await hub.topList()).find(({ name }) => name === 'Clients')!.collapsed, false)
      const [row, list] = [(await hub.topRow('billing').boundingBox())!, (await hub.shell().locator('#top').boundingBox())!]
      assert.ok(row.y >= list.y && row.y + row.height <= list.y + list.height, 'the row is in view')
      await until('billing page with the keyboard', async () => (await hub.focusedUrl()) === `http://127.0.0.1:${stubs.billing.port}/`, 5000)
      assert.equal(await pageRoot(hub), root('billing'))
      assert.deepEqual(await viewOrder(hub).then((order) => order[0]), 'shell')
      await shot('search-07-revealed.png')
      return `"billing" showed one result in Clients while Clients stayed collapsed. Enter closed the panel, selected billing, expanded Clients, scrolled the row into view, and gave billing's page the keyboard. Screenshots search-06-collapsed-group.png and search-07-revealed.png`
    })

    await check(section, 'two tabs named site are told apart by path, and a click on the second opens that project', async () => {
      await openByKey(hub)
      const results = (await search(hub, 'site')).filter(({ name }) => name === 'site')
      assert.equal(results.length, 2)
      assert.notEqual(results[0].detail, results[1].detail)
      assert.ok(results[0].detail.endsWith('/clients/site') && results[1].detail.endsWith('/other/site'), JSON.stringify(results))
      await hub.shell().locator(`#search-results li[data-root="${root('otherSite')}"]`).click()
      await until('other/site selected', async () => (await selectedRoot(hub)) === root('otherSite'), 3000)
      await until('its page', async () => (await pageRoot(hub)) === root('otherSite'), 15000)
      assert.equal(await hub.focusedUrl(), `http://127.0.0.1:${stubs.otherSite.port}/`)
      return `Details: "${results[0].detail}" and "${results[1].detail}". The click opened the page of ${root('otherSite')} on port ${stubs.otherSite.port}, with the keyboard.`
    })

    await check(section, 'an empty query lists each of the dozens of live tabs once, in sidebar order, and never the stopped tab', async () => {
      await openByKey(hub)
      const shown = await panel(hub)
      const roots = shown.results.map(({ root }) => root)
      const live = await liveRoots()
      assert.deepEqual(roots, live)
      assert.equal(new Set(roots).size, roots.length)
      assert.ok(!roots.includes(stoppedRoot))
      const statusRows = (await hub.statusList()).flatMap(({ labels }) => labels).length
      assert.equal(statusRows, live.length, 'each live tab also has a status row')
      assert.ok(roots.length >= 24)
      await shot('search-08-dozens.png')
      for (let index = 0; index < roots.length; index++) await hub.key('Down')
      await until('the last result active and in view', async () => {
        const visible = await hub.shell().evaluate(() => {
          const list = document.querySelector('#search-results')!.getBoundingClientRect()
          const item = document.querySelector('#search-results li[aria-selected="true"]')!.getBoundingClientRect()
          return item.top >= list.top && item.bottom <= list.bottom + 1
        })
        return visible && (await panel(hub)).results.at(-1)!.active
      }, 3000)
      await shot('search-09-dozens-end.png')
      await closeByEscape(hub)
      return `${roots.length} results for ${roots.length} live tabs, each once, in top list order, with ${statusRows} status rows in the window. "Stopped Named" is not listed. Down to the end kept the last result in view. Screenshots search-08-dozens.png and search-09-dozens-end.png`
    })

    await check(section, 'Up, Down, Enter, Escape, the count announcement after typing pauses, an empty query, and a query with no match', async () => {
      await openByKey(hub)
      await until('the count after opening', async () => /^\d+ results$/.test((await panel(hub)).spoken), 3000)
      const opened = await panel(hub)
      assert.equal(opened.results[0].active, true)
      assert.equal(opened.activeDescendant, 'search-result-0')
      await hub.key('Down')
      await hub.key('Down')
      await hub.key('Up')
      await until('the second result active', async () => (await panel(hub)).results[1].active, 3000)
      assert.equal((await panel(hub)).activeDescendant, 'search-result-1')
      await hub.shell().evaluate(() => {
        const holder = window as unknown as { spokenChanges: string[] }
        holder.spokenChanges = []
        new MutationObserver(() => holder.spokenChanges.push(document.querySelector('#search-count')!.textContent!)).observe(document.querySelector('#search-count')!, { childList: true, characterData: true, subtree: true })
      })
      for (const key of 'filler-0') {
        await typeKeys(hub, key)
        await sleep(80)
      }
      const duringTyping = await hub.shell().evaluate(() => (window as unknown as { spokenChanges: string[] }).spokenChanges.length)
      await sleep(ANNOUNCE_MS + 300)
      const spoken = await hub.shell().evaluate(() => (window as unknown as { spokenChanges: string[] }).spokenChanges)
      assert.equal(duringTyping, 0, 'no announcement during typing')
      assert.deepEqual(spoken, ['9 results'])
      await typeKeys(hub, 'zz')
      await until('no match', async () => (await panel(hub)).empty === 'No matching running instances', 3000)
      await until('the no-match announcement', async () => (await panel(hub)).spoken === 'No matching running instances', 3000)
      await shot('search-10-no-match.png')
      await hub.key('Enter')
      await sleep(300)
      assert.equal((await panel(hub)).open, true, 'Enter with no result does nothing')
      await closeByEscape(hub)
      await openByKey(hub)
      assert.equal((await panel(hub)).query, '', 'the panel opens with an empty query')
      await closeByEscape(hub)
      return `Opened with "${opened.spoken}" and the first result active. Down, Down, Up made the second active, through aria-activedescendant. Typing "filler-0" 80 ms per key changed the live region ${duringTyping} times, then once: ${JSON.stringify(spoken)}. "filler-0zz" showed and announced "No matching running instances". The next open had an empty query. Screenshot search-10-no-match.png`
    })

    await check(section, 'while open, a stopped tab leaves the results, the result at its place becomes active, a restart on a new port keeps the active root, and Enter opens the new port', async () => {
      await openByKey(hub)
      let results = await search(hub, 'filler-1')
      const names = results.map(({ name }) => name)
      assert.deepEqual(names, FILLERS.filter((filler) => filler.startsWith('filler-1')))
      await hub.key('Down')
      await until('filler-11 active', async () => (await panel(hub)).results.find(({ active }) => active)?.name === 'filler-11', 3000)
      await stubs['filler-11'].stop()
      await until('filler-11 gone and filler-12 active', async () => {
        const { results } = await panel(hub)
        return !results.some(({ name }) => name === 'filler-11') && results.find(({ active }) => active)?.name === 'filler-12'
      }, NEXT_SCAN_MS * 2)
      const oldPort = stubs['filler-12'].port
      await stubs['filler-12'].stop()
      stubs['filler-12'] = await startStub(home, root('filler-12'))
      const newPort = stubs['filler-12'].port
      assert.notEqual(newPort, oldPort)
      await until('the scan sees the new port', async () => (await hub.topRows()).find(({ label }) => label === 'filler-12')?.port === newPort, NEXT_SCAN_MS * 2)
      results = (await panel(hub)).results
      assert.equal(results.find(({ active }) => active)?.name, 'filler-12')
      assert.ok(!results.some(({ name }) => name === 'filler-11'))
      await shot('search-11-after-restart.png')
      await hub.key('Enter')
      await until('filler-12 page on the new port', async () => (await hub.shown()).visible[0]?.url === `http://127.0.0.1:${newPort}/`, 15000)
      assert.equal(await pageRoot(hub), root('filler-12'))
      const pages = (await hub.shown()).visible
      return `"filler-1" listed ${names.join(', ')}. Stopping the active filler-11 removed it, and filler-12 at its place became active. filler-12 moved from port ${oldPort} to ${newPort}, stayed active, and Enter showed ${pages[0].url}, the page of ${root('filler-12')}. Screenshot search-11-after-restart.png`
    })

    await check(section, 'main refuses a chosen tab that is no longer live, and search stays open with the selection unchanged', async () => {
      await openByKey(hub)
      const before = await selectedRoot(hub)
      const answer = await hub.shell().evaluate((stopped) => (window as unknown as { hub: { closeSearch(root: string): Promise<boolean> } }).hub.closeSearch(stopped), root('filler-11'))
      assert.equal(answer, false)
      assert.equal((await panel(hub)).open, true)
      assert.deepEqual(await viewOrder(hub).then((order) => order.at(-1)), 'shell')
      assert.equal(await selectedRoot(hub), before)
      await closeByEscape(hub)
      return `closeSearch with the stopped filler-11 answered false. The shell stayed on top with the panel open, and the selection stayed ${before}.`
    })

    await check(section, 'typing sends no message to main, makes no request, writes no log line, and saves nothing; closing does send one, so the spy can see it', async () => {
      await openByKey(hub)
      await hub.evaluate(({ BaseWindow, ipcMain, session }) => {
        const shell = (BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]).find((view) => view.webContents.getURL().startsWith('file:'))!
        const seen: string[] = []
        ;(globalThis as unknown as { searchSpy: string[] }).searchSpy = seen
        shell.webContents.on('ipc-message', (_event, channel) => seen.push(`send ${channel}`))
        shell.webContents.on('ipc-message-sync', (_event, channel) => seen.push(`sync ${channel}`))
        // Electron calls invoke handlers from this map directly, with no event to listen to.
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
        for (const [channel, handler] of handlers)
          handlers.set(channel, (...args: unknown[]) => {
            seen.push(`invoke ${channel}`)
            return handler(...args)
          })
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
          seen.push(`request ${details.url}`)
          callback({})
        })
      }, null)
      const logBefore = hub.log()
      const savedBefore = statSync(join(userData, 'tabs.json')).mtimeMs
      await search(hub, 'quietquery')
      await search(hub, 'filler')
      const typing = await hub.evaluate(() => [...(globalThis as unknown as { searchSpy: string[] }).searchSpy], null)
      await closeByEscape(hub)
      const closing = await hub.evaluate(() => [...(globalThis as unknown as { searchSpy: string[] }).searchSpy], null)
      await hub.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null), null)
      assert.deepEqual(typing, [])
      assert.ok(closing.includes('invoke close-search'), JSON.stringify(closing))
      assert.equal(hub.log(), logBefore)
      assert.ok(!hub.log().includes('quietquery'))
      assert.equal(statSync(join(userData, 'tabs.json')).mtimeMs, savedBefore)
      return `While typing "quietquery" and "filler": ${typing.length} messages to main and no requests from the shell. Escape then gave ${JSON.stringify(closing)}, so the spy sees messages. hub.log and tabs.json did not change. The shell has no Node access, so typing cannot crawl files or call Ultimate.`
    })
  } finally {
    await hub.quit()
    await real?.stop()
    model.close()
    for (const stub of Object.values(stubs)) await stub.stop()
  }

  await check(section, 'with no live tab, the panel says No Ultimate running, and opening it starts nothing', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'tabs.json'), JSON.stringify({ groups: [], tabs: [{ root: join(tempDir('projects'), 'named'), name: 'Named', groupId: null }] }))
    const empty = await Hub.launch(home, userData)
    try {
      await until('the dimmed tab', async () => (await empty.topRows()).length === 1)
      await empty.shell().locator('#search-open').click()
      await until('the empty panel', async () => (await panel(empty)).empty === 'No Ultimate running', 3000)
      const shown = await panel(empty)
      assert.deepEqual(shown.results, [])
      await sleep(ANNOUNCE_MS + 200)
      assert.equal((await panel(empty)).spoken, 'No Ultimate running')
      await empty.screenshot(join(EVIDENCE, 'search-12-no-ultimate.png'))
      await empty.key('Escape')
      await until('closed', async () => !(await panel(empty)).open, 3000)
      assert.deepEqual(await empty.topRows().then((rows) => rows.map(({ dimmed }) => dimmed)), [true])
      return 'With only a dimmed tab, the panel listed nothing and showed and announced "No Ultimate running". The tab stayed dimmed. Screenshot search-12-no-ultimate.png'
    } finally {
      await empty.quit()
    }
  })
}
