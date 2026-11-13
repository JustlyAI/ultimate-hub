import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BareHub } from '../support/bare.ts'
import { sleep, startStub, tempDir, until, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

const COUNT = 30
const PASSES = 6
const DECISION_P95_MS = 100

export const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
export const p95 = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))]

export const SHOWN_AT = '(window.shownAt ?? 0)'

export async function measureSwitches(hub: BareHub, count: number) {
  const samples: number[] = []
  for (let index = 0; index < count; index++) {
    const before = await hub.inShown<string>('location.href')
    const sentAt = await hub.switchTab()
    const shownAt = await until(
      'the new page to draw',
      async () => {
        const [href, shown] = await hub.inShown<[string, number]>(`[location.href, ${SHOWN_AT}]`)
        return href !== before && shown >= sentAt ? shown : null
      },
      3000,
    )
    samples.push(shownAt - sentAt)
    await sleep(50)
  }
  return samples
}

export async function appMemory(hub: BareHub) {
  const byType = await hub.main(({ app }) => {
    const totals: Record<string, { count: number; workingSetMb: number }> = {}
    for (const { type, memory } of app.getAppMetrics()) {
      totals[type] ??= { count: 0, workingSetMb: 0 }
      totals[type].count++
      totals[type].workingSetMb += memory.workingSetSize / 1024
    }
    return totals
  })
  const rssKb = execFileSync('/bin/ps', ['-o', 'rss=', '-p', hub.tree().join(',')], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .reduce((sum, line) => sum + Number(line), 0)
  return { byType, totalWorkingSetMb: Math.round(Object.values(byType).reduce((sum, row) => sum + row.workingSetMb, 0)), psRssSumMb: Math.round(rssKb / 1024) }
}

function cpuOfOneLsof(): number {
  const { stderr } = spawnSync('/usr/bin/time', ['-p', '/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' })
  const seconds = [...stderr.matchAll(/^(user|sys) +([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[2]), 0)
  return Math.round(seconds * 1000)
}

type StatusListState = { scrollTop: number; maxScroll: number; selectedInside: boolean; middle: { x: number; y: number } }
type SidebarState = { scrollTop: number; maxScroll: number; clientHeight: number; selected: string; selectedInside: boolean; rows: number; last: { label: string; x: number; y: number; inside: boolean }; first: { x: number; y: number }; middle: { x: number; y: number }; status: StatusListState }

const READ_SIDEBAR = `(() => {
  const inside = (row, list) => {
    const box = list.getBoundingClientRect()
    const { top, bottom } = row.getBoundingClientRect()
    return top >= box.top - 0.5 && bottom <= box.bottom + 0.5
  }
  const middle = (list) => {
    const box = list.getBoundingClientRect()
    return { x: Math.round(box.x + box.width / 3), y: Math.round(box.y + box.height / 2) }
  }
  const list = document.querySelector('#top')
  const status = document.querySelector('#status')
  const point = (row) => {
    const rect = row.getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 3), y: Math.round(rect.y + rect.height / 2) }
  }
  const rows = [...list.querySelectorAll('.tab')]
  const selected = rows.find((row) => row.ariaSelected === 'true')
  const last = rows.at(-1)
  const statusSelected = status.querySelector('[aria-selected="true"]')
  return {
    scrollTop: list.scrollTop,
    maxScroll: list.scrollHeight - list.clientHeight,
    clientHeight: list.clientHeight,
    selected: selected.querySelector('.label').textContent,
    selectedInside: inside(selected, list),
    rows: rows.length,
    last: { label: last.querySelector('.label').textContent, inside: inside(last, list), ...point(last) },
    first: point(rows[0]),
    middle: middle(list),
    status: {
      scrollTop: status.scrollTop,
      maxScroll: status.scrollHeight - status.clientHeight,
      selectedInside: !statusSelected || inside(statusSelected, status),
      middle: middle(status),
    },
  }
})()`

async function sidebarChecks(check: Check, hub: BareHub, home: string, stubs: Stub[]) {
  const sidebar = () => hub.inShell<SidebarState>(READ_SIDEBAR)
  const wheel = (deltaY: number, { x, y } = { x: 100, y: 300 }) =>
    hub.shellInput([
      { type: 'mouseMove', x, y },
      { type: 'mouseWheel', x, y, deltaX: 0, deltaY, canScroll: true },
    ])
  const clickAt = ({ x, y }: { x: number; y: number }) =>
    hub.shellInput([
      { type: 'mouseMove', x, y },
      { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
    ])
  /** Wheels until both lists stop moving, because a wheel scroll can animate. */
  const wheelUntil = async (deltaY: number, done: (state: SidebarState) => boolean, at?: { x: number; y: number }) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (done(await sidebar())) break
      await wheel(deltaY, at)
      await sleep(80)
    }
    let previous = ''
    for (let state = await sidebar(); `${state.scrollTop} ${state.status.scrollTop}` !== previous; state = await sidebar()) {
      previous = `${state.scrollTop} ${state.status.scrollTop}`
      await sleep(150)
    }
    return sidebar()
  }

  await check('sidebar', 'a real wheel event reaches the last row, and a real click selects it', async () => {
    const atTop = await wheelUntil(240, ({ scrollTop }) => scrollTop === 0)
    assert.equal(atTop.scrollTop, 0)
    assert.ok(atTop.maxScroll > 0, 'the list must overflow at this window size')
    assert.equal(atTop.last.inside, false, 'the last row starts below the fold')
    const atEnd = await wheelUntil(-240, ({ scrollTop, maxScroll }) => scrollTop >= maxScroll - 1)
    assert.ok(atEnd.scrollTop >= atEnd.maxScroll - 1, `scrollTop ${atEnd.scrollTop} of ${atEnd.maxScroll}`)
    assert.equal(atEnd.last.inside, true, 'the last row is fully visible')
    await clickAt(atEnd.last)
    const selected = await until('the last row to be selected', async () => {
      const state = await sidebar()
      return state.selected === atEnd.last.label ? state : null
    }, 3000)
    return `${selected.rows} rows and ${selected.clientHeight} px visible. Wheel moved scrollTop from 0 to ${atEnd.scrollTop} of ${atEnd.maxScroll}, and a click selected ${selected.selected}.`
  })

  await check('sidebar', 'Ctrl+Tab through all 30 tabs: at each step the selected row is fully inside the visible list', async () => {
    const hidden: string[] = []
    let steps = 0
    for (let index = 0; index < COUNT; index++) {
      const before = (await sidebar()).selected
      await until('focus on a page', () => hub.main(({ webContents }) => webContents.getFocusedWebContents()?.getURL().startsWith('http') === true), 3000)
      await hub.switchTab()
      await until('a new selection', async () => (await sidebar()).selected !== before, 3000)
      await sleep(60)
      const state = await sidebar()
      steps++
      if (!state.selectedInside) hidden.push(`${state.selected} in the top list`)
      if (!state.status.selectedInside) hidden.push(`${state.selected} in the Status list`)
    }
    assert.equal(hidden.length, 0, `${hidden.length} of ${steps * 2} selected rows off screen: ${hidden.join(', ')}`)
    return `${steps} steps forward, including the wrap, and every selected row was fully visible in both lists.`
  })

  await check('sidebar', 'a scan that changes another tab does not move the list, even when the selected row is off screen', async () => {
    await wheelUntil(240, ({ scrollTop }) => scrollTop === 0)
    await clickAt((await sidebar()).first)
    await sleep(300)
    const start = await wheelUntil(-8, ({ scrollTop }) => scrollTop >= 40)
    assert.ok(start.scrollTop > 0 && start.scrollTop < start.maxScroll, `scrollTop ${start.scrollTop}`)
    assert.equal(start.selectedInside, false, 'the selected row is scrolled away')
    const index = 15
    const old = stubs[index]
    await old.stop()
    stubs[index] = await startStub(home, old.root)
    const samples = new Set<number>()
    const deadline = Date.now() + 8000
    let changedAt: number | null = null
    while (Date.now() < deadline) {
      const scrollTop = (await sidebar()).scrollTop
      samples.add(scrollTop)
      const port = await hub.inShell<number | null>(`Number(document.querySelector('#top .tab[data-root=${JSON.stringify(old.root)}] .port')?.textContent ?? 0) || null`)
      if (port === stubs[index].port) changedAt ??= Date.now()
      if (changedAt && Date.now() - changedAt > 1500) break
      await sleep(25)
    }
    assert.ok(changedAt, 'the port change reached the sidebar')
    assert.notEqual(stubs[index].port, old.port)
    assert.deepEqual([...samples], [start.scrollTop], `scrollTop moved: ${[...samples].join(', ')}`)
    return `row ${index} went from port ${old.port} to ${stubs[index].port}. scrollTop stayed ${start.scrollTop}, sampled every 25 ms, with the selected row off screen.`
  })

  await check('sidebar', 'each list scrolls on its own, and a status change does not move either list', async () => {
    const before = await sidebar()
    assert.ok(before.status.maxScroll > 0, 'the Status list must overflow at this window size')
    const statusScrolled = await wheelUntil(-8, ({ status }) => status.scrollTop >= 60, before.status.middle)
    assert.ok(statusScrolled.status.scrollTop >= 60 && statusScrolled.status.scrollTop < statusScrolled.status.maxScroll, `Status scrollTop ${statusScrolled.status.scrollTop}`)
    assert.equal(statusScrolled.scrollTop, before.scrollTop, 'a wheel on the Status list does not move the top list')
    const topScrolled = await wheelUntil(-8, ({ scrollTop }) => scrollTop >= before.scrollTop + 60, before.middle)
    assert.equal(topScrolled.status.scrollTop, statusScrolled.status.scrollTop, 'a wheel on the top list does not move the Status list')
    const changed = stubs[20]
    await fetch(`http://127.0.0.1:${changed.port}/status-control`, { method: 'POST', body: JSON.stringify({ result: { busy: 1 } }) })
    const samples = new Set<string>()
    const deadline = Date.now() + 15000
    let changedAt: number | null = null
    while (Date.now() < deadline) {
      const state = await sidebar()
      samples.add(`${state.scrollTop} ${state.status.scrollTop}`)
      const working = await hub.inShell<boolean>(`!!document.querySelector('.status-heading[data-kind="working"]')`)
      if (working) changedAt ??= Date.now()
      if (changedAt && Date.now() - changedAt > 1500) break
      await sleep(25)
    }
    assert.ok(changedAt, 'the status change reached the Status list')
    assert.deepEqual([...samples], [`${topScrolled.scrollTop} ${topScrolled.status.scrollTop}`], `scroll positions moved: ${[...samples].join(', ')}`)
    return `A wheel on the Status list moved it to ${statusScrolled.status.scrollTop} of ${statusScrolled.status.maxScroll} px, and the top list stayed at ${before.scrollTop}. A wheel on the top list moved it to ${topScrolled.scrollTop}, and the Status list stayed. ${changed.root.split('/').pop()} went to Working, and both positions stayed ${[...samples][0]}, sampled every 25 ms.`
  })
}

export async function runScaleChecks(check: Check) {
  const home = tempDir('home')
  const projects = tempDir('projects')
  const stubs = await Promise.all(
    Array.from({ length: COUNT }, (_, index) => startStub(home, join(projects, `project-${String(index).padStart(2, '0')}`))),
  )
  const hub = await BareHub.launch(home, tempDir('data'))
  const measured: Record<string, unknown> = { tabs: COUNT, driver: 'main process inspector, no page debugger' }
  try {
    await until(`${COUNT} tabs`, async () => (await hub.topRows()).length === COUNT, 5000)
    for (let index = 0; index < COUNT; index++) {
      await until('a loaded page', () => hub.inShown('document.readyState === "complete" && !!document.querySelector("#filler")'))
      await hub.switchTab()
      await sleep(30)
    }
    await sleep(2000)

    await check('scale', `${COUNT} loaded tabs are open, and every page but one is really hidden`, async () => {
      const states = await hub.inAllPages<string>('document.visibilityState')
      assert.equal(states.length, COUNT)
      assert.equal(states.filter((state) => state === 'visible').length, 1)
      assert.equal(states.filter((state) => state === 'hidden').length, COUNT - 1)
      return `${COUNT} page views: 1 visible, ${COUNT - 1} hidden, read from the pages`
    })

    await check('scale', `Ctrl+Tab switch time with ${COUNT} loaded tabs is under ${DECISION_P95_MS} ms at p95`, async () => {
      const frames = await hub.inShown<number>(`new Promise((done) => {
        const start = performance.now(); let n = 0
        const step = () => (++n === 60 ? done((performance.now() - start) / 60) : requestAnimationFrame(step))
        requestAnimationFrame(step)
      })`)
      const passes: number[][] = []
      for (let pass = 0; pass < PASSES; pass++) passes.push(await measureSwitches(hub, COUNT))
      const samples = passes.flat()
      const stats = {
        switches: samples.length,
        medianMs: median(samples),
        p95Ms: p95(samples),
        maxMs: Math.max(...samples),
        minMs: Math.min(...samples),
        passMediansMs: passes.map(median),
        frameIntervalMs: Number(frames.toFixed(1)),
      }
      measured.switch = stats
      assert.ok(stats.p95Ms < DECISION_P95_MS, `p95 ${stats.p95Ms} ms`)
      return `${stats.switches} switches, none missed. Key input to the second frame of the new page: median ${stats.medianMs} ms, p95 ${stats.p95Ms} ms, max ${stats.maxMs} ms. Pass medians ${stats.passMediansMs.join(', ')} ms. Frame interval ${stats.frameIntervalMs} ms.`
    })

    await check('scale', 'the pixels after a switch belong to the new project', async () => {
      const times: number[] = []
      for (let index = 0; index < 20; index++) {
        const result = await hub.main(async ({ webContents, BaseWindow }) => {
          const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
          const visible = () => pages.find((view) => view.getVisible())!
          const from = visible()
          const sentAt = Date.now()
          webContents.getFocusedWebContents()!.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
          while (visible() === from) await new Promise((resolve) => setImmediate(resolve))
          const target = visible()
          const expected = await target.webContents.executeJavaScript(
            'getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number)',
          )
          for (;;) {
            const image = await target.webContents.capturePage()
            const { width, height } = image.getSize()
            if (width > 0) {
              const at = (Math.floor(height / 2) * width + width - 20) * 4
              const bitmap = image.toBitmap()
              const actual = [bitmap[at + 2], bitmap[at + 1], bitmap[at]]
              if (actual.every((value, channel) => Math.abs(value - expected[channel]) <= 12))
                return { ms: Date.now() - sentAt, actual, expected }
            }
            if (Date.now() - sentAt > 3000) return { ms: -1, actual: [], expected }
          }
        })
        assert.notEqual(result.ms, -1, `no match for ${JSON.stringify(result.expected)}`)
        times.push(result.ms)
        await sleep(50)
      }
      const captureOnly = await hub.main(async ({ BaseWindow }) => {
        const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
        const view = pages.find((candidate) => candidate.getVisible())!
        const times: number[] = []
        for (let index = 0; index < 11; index++) {
          const started = Date.now()
          ;(await view.webContents.capturePage()).toBitmap()
          times.push(Date.now() - started)
        }
        return times
      })
      measured.pixels = { switches: 20, medianMs: median(times), maxMs: Math.max(...times), captureOnlyMedianMs: median(captureOnly) }
      return `20 switches: a capture of the view had the target page's colour after a median ${median(times)} ms, max ${Math.max(...times)} ms. One capture on a settled view alone takes a median ${median(captureOnly)} ms, so that part is the measuring tool.`
    })

    await check('scale', `memory and idle CPU with ${COUNT} loaded tabs`, async () => {
      const memory = await appMemory(hub)
      await hub.main(({ app }) => void app.getAppMetrics())
      await sleep(10000)
      const cpu = await hub.main(({ app }) => app.getAppMetrics().reduce((sum, row) => sum + row.cpu.percentCPUUsage, 0))
      const lsofMs: number[] = []
      for (let index = 0; index < 11; index++) {
        const started = performance.now()
        execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        lsofMs.push(performance.now() - started)
      }
      const lsofCpuMs = cpuOfOneLsof()
      const renderers = memory.byType.Tab
      assert.equal(renderers.count, COUNT + 1, 'one renderer for each page and the shell')
      measured.memory = { ...memory, processes: hub.tree().length, idleCpuPercentOfOneCore: Number(cpu.toFixed(1)), lsofMedianMs: Math.round(median(lsofMs)), lsofCpuMs }
      return `Electron working set total ${memory.totalWorkingSetMb} MB in ${hub.tree().length} processes, about ${Math.round(renderers.workingSetMb / renderers.count)} MB per renderer on a stub page. ps RSS sum ${memory.psRssSumMb} MB, which counts shared pages many times. Idle CPU over 10 s: ${cpu.toFixed(1)}% of one core across all app processes. One lsof call: median ${Math.round(median(lsofMs))} ms wall, ${lsofCpuMs} ms CPU, which getAppMetrics does not count.`
    })

    await sidebarChecks(check, hub, home, stubs)
  } finally {
    if (!process.env.HUB_ONLY) writeFileSync(join(EVIDENCE, 'scale.json'), JSON.stringify(measured, null, 2))
    await hub.quit()
  }

  const shown = await Hub.launch(home, tempDir('data'))
  await check('evidence', `screenshot of ${COUNT} tabs`, async () => {
    await until(`${COUNT} tabs`, async () => (await shown.topRows()).length === COUNT, 5000)
    await until('the page', () => shown.shownPage())
    await sleep(500)
    await shown.screenshot(join(EVIDENCE, '10-thirty-tabs.png'))
    await until('focus on a page', async () => (await shown.focusedUrl())?.startsWith('http'), 3000)
    await shown.key('Tab', ['control', 'shift'])
    await until('the last tab', async () => (await shown.topRows()).at(-1)?.selected, 3000)
    await sleep(400)
    await shown.screenshot(join(EVIDENCE, '12-last-tab-selected.png'))
    await shown.shell().evaluate(() => (document.querySelector('#status')!.scrollTop = 0))
    await sleep(200)
    const scrolled = await shown.scrollTops()
    assert.ok(scrolled.top > 0 && scrolled.status === 0, JSON.stringify(scrolled))
    await shown.screenshot(join(EVIDENCE, '29-lists-scroll-apart.png'))
    return `Screenshots 10-thirty-tabs.png, 12-last-tab-selected.png, and 29-lists-scroll-apart.png, with the top list at ${scrolled.top} px and the Status list at 0`
  })
  await shown.quit()
  for (const stub of stubs) await stub.stop()
}

export async function runScaleStatusCheck(check: Check) {
  const home = tempDir('home')
  const projects = tempDir('projects')
  const stubs = await Promise.all(
    Array.from({ length: COUNT }, (_, index) => startStub(home, join(projects, `project-${String(index).padStart(2, '0')}`))),
  )
  const shown = await Hub.launch(home, tempDir('data'))
  await check('status', `${COUNT} tabs: each stub gets one call per interval, and the sidebar shows the groups with counts`, async () => {
    const control = (stub: Stub, result: object) => fetch(`http://127.0.0.1:${stub.port}/status-control`, { method: 'POST', body: JSON.stringify({ result }) })
    const calls = async (stub: Stub) => (await (await fetch(`http://127.0.0.1:${stub.port}/status-calls`)).json()) as { at: number }[]
    await Promise.all(stubs.slice(0, 4).map((stub) => control(stub, { questions: { count: 1 }, busy: 0 })))
    await Promise.all(stubs.slice(4, 6).map((stub) => control(stub, { busy: 0, failures: [{ at: Date.now() }] })))
    await Promise.all(stubs.slice(6, 14).map((stub) => control(stub, { busy: 1 })))
    const counts = await until('the groups', async () => {
      const groups = await shown.statusList()
      const found = Object.fromEntries(groups.map(({ group, count }) => [group, count]))
      return found['needs-you'] === 4 && found.failed === 2 && found.working === 8 && found.idle === 16 ? groups : null
    }, 13000)
    await shown.screenshot(join(EVIDENCE, '25-thirty-tabs-grouped.png'))
    const before = await Promise.all(stubs.map(calls))
    await sleep(13000)
    const after = await Promise.all(stubs.map(calls))
    const added = after.map((list, index) => list.length - before[index].length)
    assert.ok(added.every((count) => count === 2 || count === 3), `calls in 13 s: ${added.join()}`)
    const gaps = after.flatMap((list) => (list.length >= 2 ? [list.at(-1)!.at - list.at(-2)!.at] : []))
    assert.ok(gaps.every((gap) => gap > 4900 && gap < 7000), `gaps: ${gaps.join()}`)
    return `${counts.map(({ label, count }) => `${label} ${count}`).join(', ')}. Calls per stub in 13 s: ${Math.min(...added)} to ${Math.max(...added)}. Gap between the last two calls: ${Math.min(...gaps)} to ${Math.max(...gaps)} ms. Screenshot 25-thirty-tabs-grouped.png`
  })
  await shown.quit()
  for (const stub of stubs) await stub.stop()
}
