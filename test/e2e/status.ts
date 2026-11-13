import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeProject, sleep, startScriptedModel, startStub, startUltimate, tempDir, until, type RealUltimate, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { send, settled, showProject } from './real.ts'

const NEXT_SCAN_MS = 2500
// The interval, one call's timeout, one scan, and time to render.
export const NEXT_STATUS_MS = 13000
const STATUS_PATH = '/api/extensions/status/actions/status'
const TIMEOUT_MS = 5000
const MAX_AGE_MS = 60000

type Call = { at: number; method: string; headers: Record<string, string>; args: { since?: number }; closedAfterMs?: number }

const calls = async (stub: Stub): Promise<Call[]> => (await fetch(`http://127.0.0.1:${stub.port}/status-calls`)).json() as Promise<Call[]>
const hits = async (stub: Stub) => Number(await (await fetch(`http://127.0.0.1:${stub.port}/hits`)).text())
const control = (stub: Stub, value: object) => fetch(`http://127.0.0.1:${stub.port}/status-control`, { method: 'POST', body: JSON.stringify(value) })

const asking = (count: number) => ({ result: { questions: { count }, busy: 0, failures: [], extensions: [] } })
const busy = (count: number) => ({ result: { questions: { count: 0 }, busy: count, failures: [], extensions: [] } })
const failedAt = (at: number) => ({ result: { questions: { count: 0 }, busy: 0, failures: [{ conversation: 1, title: 'A run', at, error: 'scripted', retried: false }], extensions: [] } })

/** Waits until every stub has taken one more call, so that a check that nothing changes has seen a real poll. */
async function nextRound(stubs: Stub[]) {
  const before = await Promise.all(stubs.map(async (stub) => (await calls(stub)).length))
  await until('a new status call on every stub', async () => (await Promise.all(stubs.map(calls))).every((list, index) => list.length > before[index]), NEXT_STATUS_MS)
}

export async function runStubStatusChecks(check: Check) {
  const section = 'status'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const names = ['a-first', 'absent-all', 'absent-some', 'ask-one', 'ask-two', 'bad-format', 'fail-one', 'goes-quiet', 'hung-body', 'hung-headers', 'mixed', 'moved', 'named', 'plain', 'refused', 'slow', 'was-busy', 'work-one']
  const stubs = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await startStub(home, join(projects, name))] as const)))
  const presets: Record<string, object> = {
    'absent-all': { result: {} },
    'absent-some': { result: { busy: 1 } },
    'ask-one': asking(1),
    'ask-two': asking(2),
    'bad-format': busy(1),
    'fail-one': failedAt(Date.now() - 1000),
    'goes-quiet': busy(1),
    'hung-body': busy(1),
    'hung-headers': busy(1),
    mixed: { result: { questions: { count: 1 }, busy: 1, failures: [{ at: Date.now() - 1000 }] } },
    moved: asking(1),
    refused: asking(1),
    'was-busy': busy(1),
    'work-one': busy(1),
  }
  await Promise.all(Object.entries(presets).map(([name, value]) => control(stubs[name], value)))

  const launchedAt = Date.now()
  const hub = await Hub.launch(home, tempDir('data'))
  const selected = async () => (await hub.topRows()).find((tab) => tab.selected)?.label
  const showStatus = (end: 'start' | 'end') => hub.shell().evaluate((end) => document.querySelector('#status')!.scrollTo(0, end === 'end' ? 1e6 : 0), end)
  const all = () => Object.values(stubs)
  try {
    await until('every tab', async () => (await hub.topRows()).length === names.length, 5000)

    await check(section, 'the first answers arrive within a scan, and each call is one POST with only the own Origin added', async () => {
      await until('a call on every stub', async () => (await Promise.all(all().map(calls))).every((list) => list.length > 0), NEXT_SCAN_MS)
      const first = await calls(stubs.plain)
      assert.equal(first.length, 1)
      const [{ method, headers, args, at }] = first
      assert.equal(method, 'POST')
      assert.equal(headers.origin, `http://127.0.0.1:${stubs.plain.port}`)
      assert.deepEqual(args, {}, 'a tab that was never selected asks about the default 24 hours')
      assert.equal(headers['sec-fetch-site'], undefined)
      const undici = new Set(['host', 'connection', 'content-type', 'accept', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding', 'content-length'])
      const added = Object.keys(headers).filter((name) => !undici.has(name))
      assert.deepEqual(added, ['origin'])
      return `route ${STATUS_PATH}, method ${method}, Origin ${headers.origin}, body args {}. Headers: ${Object.keys(headers).join(', ')}. The only one that the app adds is origin, and the others are what Node's fetch always sends. First call ${at - launchedAt} ms after launch began.`
    })

    await check(section, 'a status call does not load a page: an unselected tab has calls and no page hits', async () => {
      assert.ok((await calls(stubs.plain)).length >= 1)
      assert.equal(await hits(stubs.plain), 0)
      assert.equal((await hub.shown()).pages, 1)
      return `plain: ${(await calls(stubs.plain)).length} status call, 0 page hits. 1 view open, for the selected tab.`
    })

    await check(section, 'tabs group under their status with counts, the first match wins, and an empty group is hidden', async () => {
      const groups = await until('every first answer on screen', async () => {
        const found = await hub.statusList()
        return found.find(({ group }) => group === 'needs-you')?.count === 5 && !found.some(({ group }) => group === 'unknown') ? found : null
      }, NEXT_SCAN_MS)
      assert.deepEqual(groups.map(({ group }) => group), ['needs-you', 'failed', 'working', 'idle'], 'Done is empty, so it has no heading')
      const by = Object.fromEntries(groups.map(({ group, labels }) => [group, labels]))
      assert.deepEqual(by['needs-you'], ['ask-one', 'ask-two', 'mixed', 'moved', 'refused'])
      assert.ok(by['needs-you'].includes('mixed'), 'a tab with questions, failures, and busy goes to Needs You')
      assert.deepEqual(by.failed, ['fail-one'])
      assert.ok(by.working.includes('work-one'))
      for (const { count, labels } of groups) assert.equal(count, labels.length, 'the count matches the rows')
      return groups.map(({ label, count, labels }) => `${label} ${count}: ${labels.join(', ')}`).join('. ')
    })

    await check(section, 'a new tab is Unknown until its first answer, then moves to its group', async () => {
      const startedAt = Date.now()
      stubs['new-tab'] = await startStub(home, join(projects, 'new-tab'), 0, 'slow-status')
      await until('the new tab', () => hub.tab('new-tab'), NEXT_SCAN_MS)
      const shownAt = Date.now()
      assert.equal(await hub.groupOf('new-tab'), 'unknown')
      const groups = await hub.statusList()
      assert.equal(groups.at(-1)!.group, 'unknown', 'Unknown is the last group')
      await showStatus('end')
      await sleep(300)
      await hub.screenshot(join(EVIDENCE, '19-status-unknown.png'))
      await showStatus('start')
      await until('Idle after the first answer', async () => (await hub.groupOf('new-tab')) === 'idle', TIMEOUT_MS + NEXT_SCAN_MS)
      assert.equal((await calls(stubs['new-tab'])).length, 1, 'one call gave the first answer')
      return `new-tab showed ${shownAt - startedAt} ms after its stub started, in Unknown, the last group. It went to Idle ${Date.now() - shownAt} ms later, when its 4 s answer came. Groups at first: ${groups.map(({ label, count }) => `${label} ${count}`).join(', ')}. Screenshot 19-status-unknown.png`
    })

    await check(section, 'an absent field means zero: no field at all is Idle, and only busy is Working', async () => {
      assert.equal(await hub.groupOf('absent-all'), 'idle')
      assert.equal(await hub.groupOf('absent-some'), 'working')
      assert.ok(!hub.log().includes('absent'), hub.log())
      return 'absent-all with {"result":{}} is Idle, absent-some with {"result":{"busy":1}} is Working, and neither wrote a log line'
    })

    await check(section, 'a tab that is not selected and goes from busy to idle is Done, with a row between Working and Idle', async () => {
      await control(stubs['was-busy'], busy(0))
      await until('Done', async () => (await hub.groupOf('was-busy')) === 'done', NEXT_STATUS_MS)
      const labels = (await hub.statusList()).flatMap(({ labels }) => labels)
      assert.ok(labels.indexOf('was-busy') > labels.indexOf('work-one'))
      assert.ok(labels.indexOf('was-busy') < labels.indexOf('a-first'))
      return `was-busy went to Done on its next call. Order in the Status list: ${labels.join(', ')}`
    })

    await control(stubs.refused, { code: 403 })
    await control(stubs['bad-format'], { raw: 'not json' })
    await control(stubs['hung-headers'], { hang: 'headers' })
    await control(stubs['hung-body'], { hang: 'body' })
    await control(stubs.slow, { ...asking(1), delayMs: 4000 })
    const slowCalls = (await calls(stubs.slow)).length
    const lateStub = until('the slow call to start', async () => (await calls(stubs.slow)).length > slowCalls, NEXT_STATUS_MS).then(async () => {
      const started = Date.now()
      const late = await startStub(home, join(projects, 'zz-during-slow-calls'))
      await until('the tab that starts during slow calls', () => hub.tab('zz-during-slow-calls'), NEXT_SCAN_MS)
      return { late, elapsed: Date.now() - started }
    })
    await nextRound([stubs.refused, stubs['bad-format'], stubs['hung-headers'], stubs['hung-body'], stubs.slow])

    await check(section, 'a slow answer or a hung answer does not hold the scan: a new project appears during them', async () => {
      const { late, elapsed } = await lateStub
      stubs['zz-during-slow-calls'] = late
      assert.ok(elapsed < NEXT_SCAN_MS)
      return `a project that started during a 4 s answer and two hung answers had its tab after ${elapsed} ms`
    })

    await check(section, 'a slow answer still counts when it arrives', async () => {
      await until('the slow answer', async () => (await hub.groupOf('slow')) === 'needs-you', TIMEOUT_MS)
      return 'the 4 s answer moved slow to Needs You'
    })

    await check(section, 'a hung answer times out, with or without headers, and the tab keeps its last status', async () => {
      await sleep(TIMEOUT_MS + 500)
      const evidence = []
      for (const name of ['hung-headers', 'hung-body']) {
        const list = await calls(stubs[name])
        const closed = list.findLast(({ closedAfterMs }) => closedAfterMs !== undefined)?.closedAfterMs
        assert.ok(closed !== undefined && closed >= TIMEOUT_MS - 200 && closed < TIMEOUT_MS + 2000, `${name} closed after ${closed} ms`)
        assert.equal(await hub.groupOf(name), 'working')
        evidence.push(`${name}: closed after ${closed} ms, still Working`)
      }
      const log = hub.log()
      assert.ok(log.includes(`status ${stubs['hung-headers'].root}`), log)
      assert.ok(log.includes(`status ${stubs['hung-body'].root}`), log)
      return `${evidence.join('. ')}. Both are in the log.`
    })

    await check(section, 'a 403 keeps the last status and logs one line', async () => {
      assert.equal(await hub.groupOf('refused'), 'needs-you')
      await nextRound([stubs.refused])
      const lines = hub.log().split('\n').filter((line) => line.includes(`status ${stubs.refused.root}`))
      assert.equal(lines.length, 1, lines.join('\n'))
      assert.match(lines[0], /403/)
      assert.equal(await hub.groupOf('refused'), 'needs-you')
      return `refused stayed in Needs You over 2 refused calls. Log: ${lines[0]}`
    })

    await check(section, 'an answer in an unknown format keeps the last status and logs one line', async () => {
      assert.equal(await hub.groupOf('bad-format'), 'working')
      const lines = hub.log().split('\n').filter((line) => line.includes(`status ${stubs['bad-format'].root}`))
      assert.equal(lines.length, 1, lines.join('\n'))
      return `bad-format stayed in Working. Log: ${lines[0]}`
    })

    await check(section, 'a call that recovers moves the tab again', async () => {
      const recovering = { refused: 'idle', slow: 'idle', 'bad-format': 'done', 'hung-headers': 'done', 'hung-body': 'done' }
      await Promise.all(Object.keys(recovering).map((name) => control(stubs[name], asking(0))))
      await until('every recovered tab', async () => (await Promise.all(Object.entries(recovering).map(async ([name, group]) => (await hub.groupOf(name)) === group))).every(Boolean), NEXT_STATUS_MS)
      return 'on a good answer, refused and slow went to Idle. bad-format, hung-headers, and hung-body had been Working, so they went to Done.'
    })

    await check(section, 'screenshot of all five groups with counts', async () => {
      const groups = await hub.statusList()
      assert.deepEqual(groups.map(({ label }) => label), ['Needs You', 'Failed', 'Working', 'Done', 'Idle'])
      await showStatus('end')
      await sleep(300)
      await hub.screenshot(join(EVIDENCE, '20-status-groups.png'))
      await showStatus('start')
      return `Screenshot 20-status-groups.png: ${groups.map(({ label, count }) => `${label} ${count}`).join(', ')}`
    })

    await check(section, 'a status change moves only the status row: the top row, both scroll positions, and the page stay', async () => {
      const top = await hub.topRows()
      const scrolled = await hub.scrollTops()
      const shown = await hub.shown()
      assert.equal(await hub.groupOf('plain'), 'idle')
      await control(stubs.plain, asking(1))
      await until('plain in Needs You', async () => (await hub.groupOf('plain')) === 'needs-you', NEXT_STATUS_MS)
      assert.deepEqual(await hub.topRows(), top, 'the top list did not change')
      assert.deepEqual(await hub.scrollTops(), scrolled)
      assert.deepEqual(await hub.shown(), shown)
      await sleep(300)
      await hub.screenshot(join(EVIDENCE, '27-two-lists.png'))
      const groups = await hub.statusList()
      await control(stubs.plain, asking(0))
      await until('plain back in Idle', async () => (await hub.groupOf('plain')) === 'idle', NEXT_STATUS_MS)
      return `plain went from Idle to Needs You in the Status list. Its top row stayed at place ${top.findIndex(({ label }) => label === 'plain') + 1} of ${top.length}, and the scroll positions stayed ${JSON.stringify(scrolled)}. Status list: ${groups.map(({ label, labels }) => `${label} ${labels.join(', ')}`).join('. ')}. Screenshot 27-two-lists.png`
    })

    await check(section, 'a click on a status row selects the tab, both rows show as selected, its top row scrolls into view, and the page view is the same one', async () => {
      const port = stubs['work-one'].port
      await hub.select('work-one')
      const opened = await until('the work-one page', async () => (await hub.shown()).visible.find(({ url }) => url.includes(`:${port}/`)))
      const pages = (await hub.shown()).pages
      await hub.select('a-first')
      const topRowShows = () =>
        hub.shell().evaluate((label) => {
          const list = document.querySelector('#top')!.getBoundingClientRect()
          const row = [...document.querySelectorAll('#top .tab')].find((element) => element.querySelector('.label')?.textContent === label)!.getBoundingClientRect()
          return row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5
        }, 'work-one')
      await hub.shell().evaluate(() => (document.querySelector('#top')!.scrollTop = 0))
      assert.equal(await topRowShows(), false, 'the top row starts out of view')
      await hub.statusRow('work-one').click()
      await until('work-one selected', async () => (await hub.tab('work-one'))?.selected)
      assert.equal((await hub.statusList()).find(({ labels }) => labels.includes('work-one'))!.selected, 'work-one', 'the status row shows as selected')
      await until('the top row in view', topRowShows, 1000)
      const after = await hub.shown()
      assert.equal(after.pages, pages, 'no second view')
      assert.deepEqual(after.visible.map(({ id }) => id), [opened.id], 'the same view')
      await sleep(300)
      await hub.screenshot(join(EVIDENCE, '28-status-row-selected.png'))
      return `work-one was selected from its status row. Both rows showed as selected, the top list scrolled to ${(await hub.scrollTops()).top} px to show its row, and view ${opened.id} came back with ${pages} views open. Screenshot 28-status-row-selected.png`
    })

    await check(section, 'Ctrl+Tab follows the top list, not the Status list, and wraps', async () => {
      const top = (await hub.topRows()).map(({ label }) => label)
      const inStatusOrder = (await hub.statusList()).flatMap(({ labels }) => labels)
      assert.notDeepEqual(inStatusOrder, top, 'the two lists have different orders')
      await hub.select(top.at(-1)!)
      const walked: string[] = []
      for (const expected of top.slice(0, 4)) {
        await hub.keyTo('sidebar', 'Tab', ['control'])
        await until(`${expected} to be selected`, async () => (await selected()) === expected, 3000)
        walked.push(expected)
      }
      assert.deepEqual(await hub.topRows().then((rows) => rows.map(({ label }) => label)), top, 'Ctrl+Tab did not change the top list')
      return `From the last top row, Ctrl+Tab went to ${walked.join(', ')}, the first top rows. The Status list starts with ${inStatusOrder.slice(0, 4).join(', ')}.`
    })

    await check(section, 'drag between rows with different statuses reorders the top list and tabs.json, and the status rows follow', async () => {
      const saved = () => hub.savedTabs().map(({ root }) => String(root).split('/').pop())
      const inGroup = async (name: string) => (await hub.statusList()).find(({ group }) => group === name)!.labels
      assert.equal(await hub.groupOf('ask-two'), 'needs-you')
      assert.equal(await hub.groupOf('absent-some'), 'working')
      await hub.drag('ask-two', 'absent-some', 'top')
      const moved = await until('the new order', async () => {
        const labels = await hub.labels()
        return labels.indexOf('ask-two') === labels.indexOf('absent-some') - 1 ? labels : null
      }, 3000)
      assert.deepEqual(saved(), moved, 'tabs.json has the order on screen')
      const needsYou = await inGroup('needs-you')
      assert.deepEqual(needsYou, moved.filter((label) => needsYou.includes(label)), 'Needs You follows the top list')
      assert.equal(await hub.groupOf('ask-two'), 'needs-you', 'a move keeps the status')
      return `ask-two, in Needs You, moved above absent-some, in Working. Top list and tabs.json: ${moved.join(', ')}. Needs You: ${needsYou.join(', ')}`
    })

    await check(section, 'a drag from a status row, or onto the Status list, changes nothing', async () => {
      const saved = () => hub.savedTabs().map(({ root }) => String(root).split('/').pop())
      const before = { saved: saved(), top: await hub.topRows(), groups: await hub.statusList() }
      const heading = hub.shell().locator('.status-heading').first()
      await hub.statusRow('ask-one').dragTo(hub.topRow('a-first'), { targetPosition: { x: 40, y: 4 } })
      await hub.topRow('ask-one').dragTo(hub.statusRow('work-one'), { targetPosition: { x: 40, y: 4 } })
      await hub.topRow('ask-one').dragTo(heading)
      await hub.topRow('ask-one').dragTo(hub.shell().locator('#status-title'))
      await sleep(500)
      assert.deepEqual(saved(), before.saved)
      assert.deepEqual(await hub.topRows(), before.top)
      assert.deepEqual(await hub.statusList(), before.groups)
      return 'a drag from the ask-one status row onto a top row, and drags of the ask-one top row onto a status row, a status heading, and the Status title, left tabs.json, both lists, and the selection the same'
    })

    await check(section, 'a double-click on a Done tab renames that tab', async () => {
      await control(stubs['was-busy'], busy(1))
      await until('Working', async () => (await hub.groupOf('was-busy')) === 'working', NEXT_STATUS_MS)
      await control(stubs['was-busy'], busy(0))
      await until('Done', async () => (await hub.groupOf('was-busy')) === 'done', NEXT_STATUS_MS)
      const before = (await hub.topRows()).map(({ label }) => label)
      await hub.topRow('was-busy').scrollIntoViewIfNeeded()
      const box = (await hub.topRow('was-busy').boundingBox())!
      const [x, y] = [box.x + 40, box.y + box.height / 2]
      // Playwright's dblclick sends both clicks before the sidebar can redraw. A person is slower, so the Status list redraws between them.
      await hub.shell().mouse.click(x, y)
      await sleep(150)
      await hub.shell().mouse.click(x, y, { clickCount: 2 })
      const input = hub.shell().locator('input.rename')
      await input.waitFor({ timeout: 2000 })
      assert.equal(await input.inputValue(), 'was-busy')
      await input.press('Escape')
      await until('Idle', async () => (await hub.groupOf('was-busy')) === 'idle', 2000)
      assert.deepEqual((await hub.topRows()).map(({ label }) => label), before, 'the top list did not move')
      return `Two clicks 150 ms apart opened the rename input on was-busy, the row under the cursor. Escape closed it, the tab went to Idle in the Status list, and the top list stayed ${before.join(', ')}.`
    })

    await check(section, 'no group change during a rename: the row stays, the input stays, nothing is saved, and the change comes after', async () => {
      await hub.topRow('plain').dblclick()
      const input = hub.shell().locator('input.rename')
      await input.fill('half-typed')
      const before = await hub.statusList()
      await control(stubs['absent-all'], asking(1))
      await nextRound([stubs['absent-all']])
      await sleep(1500)
      assert.deepEqual(await hub.statusList(), before, 'the rows did not change')
      assert.equal(await input.inputValue(), 'half-typed')
      assert.ok(await input.evaluate((element) => element === document.activeElement), 'the input keeps focus')
      assert.equal(hub.savedTabs().find(({ root }) => root === stubs.plain.root)!.name, null, 'nothing is saved before the rename ends')
      await input.press('Escape')
      await until('the held change', async () => (await hub.groupOf('absent-all')) === 'needs-you', 1000)
      assert.equal(await hub.tab('plain').then((tab) => tab?.label), 'plain')
      return 'During a poll that changed another tab, the rows stayed, the input kept "half-typed" and focus, and tabs.json stayed the same. After Escape, the change showed.'
    })

    await check(section, 'no group change during a drag: the rows stay, the drop works, and the change comes after', async () => {
      const page = hub.shell()
      await page.evaluate(() => document.querySelector('#top')!.scrollTo(0, 0))
      const [from, to] = await Promise.all([hub.topRow('ask-one').boundingBox(), hub.topRow('ask-two').boundingBox()])
      await page.mouse.move(from!.x + 40, from!.y + 10)
      await page.mouse.down()
      await page.mouse.move(from!.x + 40, from!.y + 14)
      await page.mouse.move(to!.x + 40, to!.y + 10)
      const before = await hub.statusList()
      assert.equal(await hub.groupOf('slow'), 'idle')
      await control(stubs.slow, asking(1))
      await nextRound([stubs.slow])
      await sleep(1500)
      assert.deepEqual(await hub.statusList(), before, 'the rows did not change during the drag')
      await page.mouse.up()
      await until('the held change', async () => (await hub.groupOf('slow')) === 'needs-you', 1000)
      const labels = await hub.labels()
      assert.equal(labels.indexOf('ask-one'), labels.indexOf('ask-two') - 1, labels.join())
      const order = (await hub.statusList()).find(({ group }) => group === 'needs-you')!.labels
      assert.ok(order.indexOf('ask-one') < order.indexOf('ask-two'), order.join())
      return `During a poll that changed another tab, the rows stayed. After the drop, the order was ${order.join(', ')}, and the change showed.`
    })

    await check(section, 'selecting a Failed tab clears it at once, and the next call asks only since that time', async () => {
      assert.equal(await hub.groupOf('fail-one'), 'failed')
      await hub.select('fail-one')
      const selectedAt = Date.now()
      await until('Idle at once', async () => (await hub.groupOf('fail-one')) === 'idle', 1500)
      await nextRound([stubs['fail-one']])
      await sleep(300)
      const { args } = (await calls(stubs['fail-one'])).at(-1)!
      assert.ok(args.since && Math.abs(args.since - selectedAt) < 2000, `since ${args.since}, selected ${selectedAt}`)
      assert.equal(await hub.groupOf('fail-one'), 'idle', 'the old failure stays filtered')
      return `Idle within 1.5 s of the click. The next call sent since ${args.since}, ${args.since! - selectedAt} ms from the click, and the failure stayed filtered.`
    })

    await check(section, 'a failure after the user last selected the tab shows as Failed', async () => {
      await hub.select('a-first')
      await control(stubs['fail-one'], failedAt(Date.now()))
      await until('Failed again', async () => (await hub.groupOf('fail-one')) === 'failed', NEXT_STATUS_MS)
      return 'a new failure moved fail-one back to Failed'
    })

    await check(section, 'a project on a new port is Unknown, and a stopped named tab has no status row', async () => {
      assert.equal(await hub.groupOf('moved'), 'needs-you')
      await stubs.moved.stop()
      // The new process answers late, so a kept status would still show when the tab reaches the new port.
      stubs.moved = await startStub(home, stubs.moved.root, 0, 'slow-status')
      await until('the new port', async () => (await hub.tab('moved'))?.port === stubs.moved.port, NEXT_SCAN_MS * 2)
      assert.equal(await hub.groupOf('moved'), 'unknown')
      await hub.rename('named', 'Named')
      await control(stubs.named, asking(1))
      await until('Needs You', async () => (await hub.groupOf('Named')) === 'needs-you', NEXT_STATUS_MS)
      await stubs.named.stop()
      await until('dim, with no status row', async () => (await hub.tab('Named'))?.dimmed && (await hub.groupOf('Named')) === undefined, NEXT_SCAN_MS)
      assert.equal(await hub.statusRow('Named').count(), 0)
      return 'moved was Unknown as soon as it had its new port, before its first answer came. Named left Needs You when it stopped, and stayed in the top list, dimmed.'
    })

    await check(section, 'a tab whose status calls fail goes to Unknown when its last good answer is 60 s old, never to Failed, and back on a good answer', async () => {
      assert.equal(await hub.groupOf('goes-quiet'), 'working')
      const failingFrom = Date.now()
      await control(stubs['goes-quiet'], { code: 500 })
      const lastGood = (await calls(stubs['goes-quiet'])).findLast(({ at }) => at < failingFrom)!.at
      const seen = new Set<string>()
      const unknownAt = await until('Unknown', async () => {
        const group = await hub.groupOf('goes-quiet')
        seen.add(String(group))
        return group === 'unknown' ? Date.now() : null
      }, MAX_AGE_MS + NEXT_STATUS_MS)
      const age = unknownAt - lastGood
      assert.ok(age > MAX_AGE_MS && age < MAX_AGE_MS + 3000, `Unknown ${age} ms after the last good call`)
      assert.deepEqual([...seen], ['working', 'unknown'], 'never Failed, and nothing between')
      await hub.select('goes-quiet')
      assert.equal(await hub.groupOf('goes-quiet'), 'unknown', 'selecting the tab does not give it an answer')
      await sleep(300)
      await hub.screenshot(join(EVIDENCE, '26-status-stale-unknown.png'))
      const lines = hub.log().split('\n').filter((line) => line.includes(`status ${stubs['goes-quiet'].root}`))
      assert.equal(lines.length, 1, lines.join('\n'))
      await control(stubs['goes-quiet'], busy(1))
      const answeredFrom = Date.now()
      await until('Working again', async () => (await hub.groupOf('goes-quiet')) === 'working', NEXT_STATUS_MS)
      return `Working until ${age} ms after the last good call started, then Unknown, with no other group between. ${(await calls(stubs['goes-quiet'])).filter(({ at }) => at >= failingFrom).length} calls since the stub began to fail. Log: ${lines[0]}. Working again ${Date.now() - answeredFrom} ms after the stub answered again. Screenshot 26-status-stale-unknown.png`
    })
  } finally {
    await hub.quit()
    for (const stub of Object.values(stubs)) await stub.stop()
  }
}

async function readReal(port: number, since?: number) {
  const origin = `http://127.0.0.1:${port}`
  const response = await fetch(`${origin}${STATUS_PATH}`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ args: since === undefined ? {} : { since } }) })
  return ((await response.json()) as { result: { questions: { count: number }; busy: number; failures?: unknown[] } }).result
}

export async function runRealStatusChecks(check: Check) {
  const section = 'real status'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const model = await startScriptedModel()
  const [rootA, rootB] = ['status-a', 'status-b'].map((name) => makeProject(projects, name))
  const a: RealUltimate = startUltimate(home, rootA, model.agentDir)
  const b: RealUltimate = startUltimate(home, rootB, model.agentDir)
  const portB = await b.port()
  await a.port()
  const hub = await Hub.launch(home, tempDir('data'))
  const measured: Record<string, number> = {}
  const groupIs = (label: string, group: string, timeout = NEXT_STATUS_MS) => until(`${label} in ${group}`, async () => (await hub.groupOf(label)) === group, timeout)
  try {
    await until('two tabs', async () => (await hub.topRows()).length === 2, 10000)
    await showProject(hub, 'status-a', rootA)
    const page = await showProject(hub, 'status-b', rootB)
    await settled(home, rootB, page)

    await check(section, 'the call from the packaged app reaches a real Ultimate: no refusal, and both tabs are Idle', async () => {
      await sleep(NEXT_SCAN_MS)
      const answer = await readReal(portB)
      assert.equal(answer.busy, 0)
      assert.equal(answer.questions.count, 0)
      assert.deepEqual((await hub.statusList()).map(({ label, count }) => [label, count]), [['Idle', 2]])
      assert.ok(!hub.log().includes('status '), hub.log())
      return `hub.log has no status line, so no call was refused. A direct read shows ${JSON.stringify({ questions: answer.questions, busy: answer.busy, failures: answer.failures })}.`
    })

    await check(section, 'a real open question moves its tab to Needs You, and answering it moves the tab out', async () => {
      const top = await hub.topRows()
      await send(page, 'ask-owner')
      await until('the open question', async () => (await readReal(portB)).questions.count === 1, 30000)
      const askedAt = Date.now()
      await groupIs('status-b', 'needs-you')
      measured.questionToNeedsYouMs = Date.now() - askedAt
      assert.deepEqual(await hub.topRows(), top, 'the top list did not change')
      await hub.screenshot(join(EVIDENCE, '21-real-needs-you.png'))
      await page.getByRole('button', { name: 'Yes' }).click()
      await page.getByText('Send', { exact: true }).click()
      await until('no open question', async () => (await readReal(portB)).questions.count === 0, 15000)
      await until('no longer Needs You', async () => (await hub.groupOf('status-b')) !== 'needs-you', NEXT_STATUS_MS)
      return `The real status answer had 1 open question, and the tab showed Needs You ${measured.questionToNeedsYouMs} ms later. Its top row stayed in place. Answering it through the card moved the tab to ${await hub.groupOf('status-b')}. Screenshot 21-real-needs-you.png`
    })

    await check(section, 'a real busy conversation is Working, its end on an unselected tab is Done, and selecting clears Done', async () => {
      await hub.select('status-b')
      await until('not busy', async () => (await readReal(portB)).busy === 0, 30000)
      await send(page, 'hold-turn')
      await until('busy', async () => (await readReal(portB)).busy > 0, 30000)
      const busyAt = Date.now()
      await hub.select('status-a')
      await groupIs('status-b', 'working')
      measured.busyToWorkingMs = Date.now() - busyAt
      await hub.screenshot(join(EVIDENCE, '22-real-working.png'))
      model.release()
      await until('not busy', async () => (await readReal(portB)).busy === 0, 30000)
      const idleAt = Date.now()
      await groupIs('status-b', 'done')
      measured.idleToDoneMs = Date.now() - idleAt
      await hub.screenshot(join(EVIDENCE, '23-real-done.png'))
      await hub.select('status-b')
      await groupIs('status-b', 'idle', 1500)
      return `Working ${measured.busyToWorkingMs} ms after the real answer showed busy. Done ${measured.idleToDoneMs} ms after it showed 0. Selecting cleared it at once. Screenshots 22-real-working.png and 23-real-done.png`
    })

    await check(section, 'a real failed run is Failed, and selecting the tab clears it while Ultimate still reports it', async () => {
      await send(page, 'fail-turn')
      await until('the failure in the real answer', async () => ((await readReal(portB)).failures?.length ?? 0) > 0, 30000)
      await hub.select('status-a')
      await groupIs('status-b', 'failed')
      await hub.screenshot(join(EVIDENCE, '24-real-failed.png'))
      await hub.select('status-b')
      await groupIs('status-b', 'idle', 1500)
      const selectedAt = Date.now()
      await sleep(NEXT_STATUS_MS)
      const reported = (await readReal(portB)).failures?.length ?? 0
      assert.ok(reported > 0, 'the default 24 hours still shows the failure')
      assert.equal((await readReal(portB, selectedAt)).failures?.length, 0)
      assert.equal(await hub.groupOf('status-b'), 'idle', 'one more poll with since left it Idle')
      return `The real answer reported ${reported} failure. Failed before the select, and Idle after it and after one more poll. With the default 24 hours, Ultimate still reports it, so "since" is what clears it. Screenshot 24-real-failed.png`
    })

    await check(section, 'a real instance that stops is dimmed with no status row, and the app logged no refusal in the whole run', async () => {
      await hub.select('status-a')
      await hub.rename('status-b', 'Named')
      await b.stop()
      await until('dim', async () => (await hub.tab('Named'))?.dimmed, NEXT_SCAN_MS * 2)
      assert.equal(await hub.groupOf('Named'), undefined)
      assert.ok(!hub.log().includes('403'), hub.log())
      return `Stopped and dimmed. hub.log: ${JSON.stringify(hub.log().split('\n').filter((line) => line.includes('status ')))}`
    })
  } finally {
    await hub.quit().catch(() => {})
    await a.stop()
    await b.stop()
    model.close()
  }
}
