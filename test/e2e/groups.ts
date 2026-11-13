import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from 'playwright'
import { isAlive, sleep, startStub, tempDir, until, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'
import { UNGROUPED } from '../../src/shared/tabs.ts'
import { NEXT_STATUS_MS } from './status.ts'

const NEXT_SCAN_MS = 2500
const REMOVE_MESSAGE = 'Instances move to Ungrouped. Their servers keep running.'

type DragData = { items: { mimeType: string; data: string }[]; dragOperationsMask: number }

const control = (stub: Stub, value: object) => fetch(`http://127.0.0.1:${stub.port}/status-control`, { method: 'POST', body: JSON.stringify(value) })
const hits = async (stub: Stub) => Number(await (await fetch(`http://127.0.0.1:${stub.port}/hits`)).text())
const asking = (count: number) => ({ result: { questions: { count }, busy: 0, failures: [], extensions: [] } })

const dialogOpen = (hub: Hub) => hub.shell().evaluate(() => document.querySelector<HTMLDialogElement>('#name-dialog')!.open)
const refusal = (hub: Hub) =>
  hub.shell().evaluate(() => {
    const line = document.querySelector<HTMLElement>('#name-refusal')!
    return line.hidden ? null : line.textContent
  })
const savedText = (hub: Hub) => readFileSync(join(hub.userData, 'tabs.json'), 'utf8')
const groupIdOf = (hub: Hub, name: string) => hub.saved().groups.find((group) => group.name === name)?.id as string
const part = async (hub: Hub, name: string) => (await hub.topList()).find((candidate) => candidate.name === name)!
const selectedLabel = (hub: Hub) => hub.shell().evaluate(() => document.querySelector('#top .tab[aria-selected="true"] .label')?.textContent ?? null)
const partOfRow = (hub: Hub, root: string) =>
  hub.shell().evaluate((root) => {
    const row = document.querySelector(`#top .tab[data-root="${CSS.escape(root)}"]`)
    return row ? (row.closest('.user-group')?.querySelector('.name')?.textContent ?? 'Ungrouped') : null
  }, root)

async function openNameDialog(hub: Hub) {
  await hub.planMenus(['Group'])
  await hub.shell().locator('#add').click()
  await until('the name dialog', () => dialogOpen(hub))
}

async function typeName(hub: Hub, name: string) {
  await hub.shell().locator('#name-input').fill('')
  await hub.shell().keyboard.type(name)
  await hub.shell().keyboard.press('Enter')
}

async function createGroup(hub: Hub, name: string) {
  await openNameDialog(hub)
  await typeName(hub, name)
  await until(`the ${name} header`, () => hub.groupHeader(name).count())
}

async function moveByMenu(hub: Hub, root: string, label: string, group: string) {
  await hub.planMenus([group])
  await hub.topRow(label).click({ button: 'right' })
  await until(`${label} in ${group}`, async () => (await partOfRow(hub, root)) === group, 3000)
}

/** Playwright has no drag cancel. Chromium gets `dragCancel` when Escape ends a native drag. */
/** Starts a drag of a row, by its label, or of any element. */
async function startDrag(hub: Hub, from: string | Locator) {
  const shell = hub.shell()
  const cdp = await shell.context().newCDPSession(shell)
  await cdp.send('Input.setInterceptDrags', { enabled: true })
  const box = (await (typeof from === 'string' ? hub.topRow(from) : from).boundingBox())!
  let at = { x: box.x + 40, y: box.y + box.height / 2 }
  const intercepted = new Promise<DragData>((resolve) => cdp.once('Input.dragIntercepted', (event) => resolve(event.data as DragData)))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 6, y: at.y + 6, button: 'left' })
  const data = await intercepted
  return {
    async over(target: Locator, dy: number) {
      const { x, y } = (await target.boundingBox())!
      at = { x: x + 40, y: y + dy }
      for (const type of ['dragEnter', 'dragOver'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...at, data })
      await sleep(100)
    },
    async end(type: 'drop' | 'dragCancel') {
      await cdp.send('Input.dispatchDragEvent', { type, ...at, data })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
      await cdp.send('Input.setInterceptDrags', { enabled: false })
      await cdp.detach()
    },
  }
}

export async function runGroupChecks(check: Check) {
  const section = 'groups'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const userData = tempDir('data')
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
  const stubs: Record<string, Stub> = {}
  for (const name of names) stubs[name] = await startStub(home, join(projects, name))
  const rootOf = (name: string) => stubs[name].root
  let hub = await Hub.launch(home, userData)
  const shot = async (name: string) => {
    await sleep(300)
    await hub.screenshot(join(EVIDENCE, name))
  }
  const live = async () => (await hub.topRows()).filter(({ dimmed }) => !dimmed).map(({ label }) => label)
  try {
    await until('every tab', async () => (await hub.topRows()).length === names.length, 5000)

    await check(section, '+ opens a menu (native menu stubbed) with Ultimate and Group, from Enter and Space, and Escape returns focus to +', async () => {
      const add = hub.shell().locator('#add')
      assert.equal(await add.getAttribute('aria-label'), 'Add')
      assert.equal(await add.getAttribute('title'), 'Add')
      await hub.planMenus([null, null])
      await add.focus()
      await hub.shell().keyboard.press('Enter')
      await until('the menu from Enter', async () => (await hub.menusShown()).length === 1)
      await until('focus back on +', async () => (await hub.focusedInShell()) === 'add')
      await hub.shell().keyboard.press('Space')
      await until('the menu from Space', async () => (await hub.menusShown()).length === 2)
      const [menu] = await hub.menusShown()
      assert.deepEqual(menu.items, ['Ultimate', 'Group'].map((label) => ({ type: 'normal', label, checked: false, enabled: true })))
      const box = (await add.boundingBox())!
      assert.ok(Math.abs(menu.x! - box.x) <= 1 && Math.abs(menu.y! - (box.y + box.height + 2)) <= 1, `menu at ${menu.x},${menu.y}, button at ${JSON.stringify(box)}`)
      await until('focus back on +', async () => (await hub.focusedInShell()) === 'add')
      assert.equal(await dialogOpen(hub), false)
      return `Enter and Space on + each opened one menu with the items ${JSON.stringify(menu.items.map(({ label }) => label))}, at ${menu.x},${menu.y}, under the button. With no choice (the stub closes it, as Escape does), focus was on + and no dialog opened.`
    })

    await check(section, 'New group starts in Name, refuses an empty name, 61 characters, and Ungrouped, and adds the group at the end, expanded and empty, with focus on its header', async () => {
      await openNameDialog(hub)
      assert.equal(await hub.focusedInShell(), 'name-input')
      assert.equal(await hub.shell().locator('#name-title').innerText(), 'New group')
      assert.equal(await hub.shell().locator('#name-ok').innerText(), 'Create group')
      const refused: string[] = []
      for (const [name, expected] of [['   ', 'Enter a name.'], ['x'.repeat(61), 'Use 60 characters or fewer.'], ['ungrouped', 'This name is in use.']]) {
        await typeName(hub, name)
        await until(`the refusal of "${name}"`, async () => (await refusal(hub)) === expected, 2000)
        assert.equal(await dialogOpen(hub), true)
        refused.push(expected)
      }
      await typeName(hub, '  Product  ')
      await until('the Product header', () => hub.groupHeader('Product').count())
      await until('focus on the Product header', async () => (await hub.focusedInShell()) === `group:${groupIdOf(hub, 'Product')}`)
      await createGroup(hub, 'x'.repeat(60))
      await createGroup(hub, 'Tools')
      const list = await hub.topList()
      assert.deepEqual(list.map(({ name, collapsed, count, labels }) => [name, collapsed, count, labels.length]), [
        ['Product', false, 0, 0],
        ['x'.repeat(60), false, 0, 0],
        ['Tools', false, 0, 0],
        ['Ungrouped', false, names.length, names.length],
      ])
      assert.equal(list.at(-1)!.header, true, 'the Ungrouped heading shows once groups exist')
      assert.equal(await hub.focusedInShell(), `group:${groupIdOf(hub, 'Tools')}`)
      assert.deepEqual(hub.saved().groups.map(({ name }) => name), ['Product', 'x'.repeat(60), 'Tools'])
      return `The dialog refused: ${refused.join(' / ')}. It trimmed "  Product  " to Product. A 60-character name was accepted. Product, the long name, and Tools are at the end in that order, expanded, with count 0, and the new header had focus each time.`
    })

    await check(section, 'the dialog refuses a name in another letter case; Cancel and Escape change nothing and return focus to +', async () => {
      const before = savedText(hub)
      await openNameDialog(hub)
      await typeName(hub, 'PRODUCT')
      await until('the refusal', async () => (await refusal(hub)) === 'This name is in use.', 2000)
      await shot('30-group-name-dialog.png')
      await hub.shell().locator('#name-cancel').click()
      await until('the dialog closes', async () => !(await dialogOpen(hub)))
      assert.equal(await hub.focusedInShell(), 'add')
      await openNameDialog(hub)
      await hub.shell().keyboard.type('Other')
      await hub.shell().keyboard.press('Escape')
      await until('the dialog closes', async () => !(await dialogOpen(hub)))
      assert.equal(await hub.focusedInShell(), 'add')
      await sleep(300)
      assert.equal(savedText(hub), before)
      assert.equal((await hub.topList()).length, 4)
      return 'PRODUCT was refused with "This name is in use." (screenshot 30-group-name-dialog.png). Cancel, and Escape after typing Other, closed the dialog, put focus on +, and left tabs.json the same.'
    })

    await check(section, 'removing the long group (native menu stubbed) needs no question when it is empty', async () => {
      const long = 'x'.repeat(60)
      await hub.planMenus(['Remove group'])
      await hub.planSheets([])
      await hub.groupHeader(long).locator('.group-menu').click()
      await until('the long group goes', async () => !(await hub.topList()).some(({ name }) => name === long))
      const [menu] = (await hub.menusShown()).slice(-1)
      assert.deepEqual(menu.items.map(({ label }) => label), ['Rename group', 'Remove group'])
      assert.deepEqual(await hub.sheetsShown(), [], 'no question for an empty group')
      assert.equal(await hub.focusedInShell(), 'add')
      return 'The group menu listed Rename group and Remove group. The empty group went with no sheet, and focus went to +.'
    })

    await check(section, 'Move to group from the keyboard only: Tab to a row, Shift+F10 (native menu stubbed), and the tab goes to the end of the group', async () => {
      const root = rootOf('alpha')
      await hub.shell().locator('#add').focus()
      const passed: string[] = []
      for (let step = 0; step < 30 && (await hub.focusedInShell()) !== `row:${root}`; step++) {
        await hub.shell().keyboard.press('Tab')
        passed.push(await hub.focusedInShell())
      }
      assert.equal(await hub.focusedInShell(), `row:${root}`, `Tab passed ${passed.join(', ')}`)
      await hub.planMenus(['Tools'])
      await hub.shell().keyboard.press('Shift+F10')
      await until('alpha in Tools', async () => (await partOfRow(hub, root)) === 'Tools', 3000)
      const menu = (await hub.menusShown()).at(-1)!
      assert.deepEqual(menu.items, [
        { type: 'normal', label: 'Rename', checked: false, enabled: true },
        { type: 'normal', label: 'Close Ultimate…', checked: false, enabled: true },
        { type: 'header', label: 'Move to group', checked: false, enabled: true },
        { type: 'normal', label: 'Product', checked: false, enabled: true },
        { type: 'normal', label: 'Tools', checked: false, enabled: true },
        { type: 'checkbox', label: 'Ungrouped', checked: true, enabled: true },
      ])
      await until('focus stays on the row', async () => (await hub.focusedInShell()) === `row:${root}`, 2000)
      assert.deepEqual((await part(hub, 'Tools')).labels, ['alpha'])
      const opened = (await hub.menusShown()).length
      await hub.planMenus([null])
      await hub.topRow('alpha').click({ button: 'right' })
      await until('the right-click menu', async () => (await hub.menusShown()).length === opened + 1)
      const right = (await hub.menusShown()).at(-1)!
      assert.deepEqual(right.items.filter(({ checked }) => checked).map(({ label }) => label), ['Tools'])
      return `Tab went ${passed.length} steps (${passed.join(', ')}) to the alpha row. Shift+F10 opened the row menu with ${menu.items.map(({ label, checked }) => `${label}${checked ? ' (checked)' : ''}`).join(', ')}. alpha went to Tools and kept focus. A right-click opened the same menu with Tools checked.`
    })

    await check(section, 'drags move a live row onto a row in another group, into an empty group, and back to Ungrouped, and each root has one top row', async () => {
      await hub.drag('beta', 'alpha', 'top')
      await until('beta above alpha in Tools', async () => (await part(hub, 'Tools')).labels.join() === 'beta,alpha', 3000)
      await hub.topRow('gamma').dragTo(hub.groupHeader('Product'))
      await until('gamma in Product', async () => (await part(hub, 'Product')).labels.join() === 'gamma', 3000)
      await hub.topRow('alpha').dragTo(hub.groupHeader('Ungrouped'))
      await until('alpha at the end of Ungrouped', async () => (await part(hub, 'Ungrouped')).labels.at(-1) === 'alpha', 3000)
      const anchor = (await part(hub, 'Ungrouped')).labels.find((label) => label !== 'delta')!
      await hub.drag('delta', anchor, 'bottom')
      await until(`delta after ${anchor}`, async () => {
        const labels = (await part(hub, 'Ungrouped')).labels
        return labels[labels.indexOf(anchor) + 1] === 'delta'
      }, 3000)
      const roots = await hub.topRoots()
      assert.equal(new Set(roots).size, roots.length, 'one top row for each root')
      assert.equal(roots.length, names.length)
      return `Tools: ${(await part(hub, 'Tools')).labels.join(', ')}. Product: ${(await part(hub, 'Product')).labels.join(', ')}. Ungrouped: ${(await part(hub, 'Ungrouped')).labels.join(', ')}. ${roots.length} top rows for ${roots.length} roots.`
    })

    await check(section, 'during a drag, a header shows an outline and a row shows an insertion line, and a drop on the header moves the tab', async () => {
      const drag = await startDrag(hub, 'epsilon')
      await drag.over(hub.topRow('beta'), 4)
      const line = await hub.topRow('beta').evaluate((row) => row.classList.contains('drop-before'))
      await drag.over(hub.groupHeader('Product'), 15)
      const outlined = await hub.groupHeader('Product').evaluate((header) => [header.classList.contains('drop-into'), getComputedStyle(header).outlineStyle])
      await shot('32-drag-onto-header.png')
      await drag.end('drop')
      await until('epsilon at the end of Product', async () => (await part(hub, 'Product')).labels.join() === 'gamma,epsilon', 3000)
      assert.equal(line, true, 'the insertion line above beta')
      assert.deepEqual(outlined, [true, 'solid'], 'the outline on the Product header')
      assert.equal(await hub.shell().locator('.drop-into, .drop-before, .drop-after').count(), 0, 'no mark after the drop')
      return 'Over the top half of beta, the row had the insertion line. Over the Product header, the header had a solid outline (screenshot 32-drag-onto-header.png). The drop put epsilon at the end of Product, and no mark stayed.'
    })

    await check(section, 'Escape during a drag (CDP dragCancel), a drop outside a target, and a drop at the same place change nothing', async () => {
      const before = { saved: savedText(hub), list: await hub.topList() }
      const cancelled = await startDrag(hub, 'delta')
      await cancelled.over(hub.groupHeader('Tools'), 15)
      await cancelled.end('dragCancel')
      await sleep(600)
      assert.equal(await hub.shell().locator('.drop-into').count(), 0, 'the outline goes with the drag')
      for (const target of ['#message', '#top-title', '#status-title']) await hub.topRow('delta').dragTo(hub.shell().locator(target))
      await hub.drag('delta', 'delta', 'top')
      const ungrouped = (await part(hub, 'Ungrouped')).labels
      await hub.drag('delta', ungrouped[ungrouped.indexOf('delta') + 1], 'top')
      await sleep(800)
      assert.equal(savedText(hub), before.saved)
      assert.deepEqual(await hub.topList(), before.list)
      return 'A drag of delta over the Tools header, then cancelled, a drop on the message area, the Ultimates title, and the Status title, a drop on itself, and a drop above the next row left tabs.json and the top list the same.'
    })

    await check(section, 'an unnamed tab in a group that stops stays dimmed in its place with no status row, and once ungrouped it leaves the list when another tab is selected', async () => {
      await stubs.epsilon.stop()
      await until('epsilon dimmed', async () => (await hub.tab('epsilon'))?.dimmed, NEXT_SCAN_MS)
      assert.deepEqual((await part(hub, 'Product')).labels, ['gamma', 'epsilon'], 'in its place')
      assert.equal((await part(hub, 'Product')).count, 2, 'the count holds the dimmed row')
      assert.equal(await hub.groupOf('epsilon'), undefined, 'no status row')
      await hub.select('epsilon')
      await until('epsilon selected', async () => (await selectedLabel(hub)) === 'epsilon')
      await moveByMenu(hub, rootOf('epsilon'), 'epsilon', 'Ungrouped')
      assert.equal((await part(hub, 'Ungrouped')).labels.at(-1), 'epsilon', 'selected, so it stays')
      await hub.select('alpha')
      await until('epsilon leaves', async () => (await hub.tab('epsilon')) === undefined, 3000)
      return 'epsilon stopped and stayed dimmed second in Product, with count 2 and no status row. Selected and moved to Ungrouped, it stayed last. When alpha was selected, it left the list.'
    })

    await check(section, 'a drop on a collapsed header puts a dimmed row and a live row at the end of the group, and the group stays collapsed', async () => {
      await hub.rename('zeta', 'Named')
      await until('Named', () => hub.tab('Named'))
      await stubs.zeta.stop()
      await until('Named dimmed', async () => (await hub.tab('Named'))?.dimmed, NEXT_SCAN_MS)
      await hub.groupHeader('Tools').locator('.toggle').click()
      await until('Tools collapsed', async () => (await part(hub, 'Tools')).collapsed)
      await hub.topRow('Named').dragTo(hub.groupHeader('Tools'))
      await until('Named in Tools', async () => (await partOfRow(hub, rootOf('zeta'))) === 'Tools', 3000)
      await hub.topRow('eta').dragTo(hub.groupHeader('Tools'))
      await until('eta in Tools', async () => (await partOfRow(hub, rootOf('eta'))) === 'Tools', 3000)
      const tools = await part(hub, 'Tools')
      assert.equal(tools.collapsed, true)
      assert.equal(tools.count, 3)
      const id = groupIdOf(hub, 'Tools')
      const order = hub.savedTabs().filter(({ groupId }) => groupId === id).map(({ root }) => String(root).split('/').pop())
      assert.deepEqual(order, ['beta', 'zeta', 'eta'])
      return `The dimmed Named row and the live eta row went onto the collapsed Tools header. Tools stayed collapsed with count ${tools.count}, and tabs.json holds Tools as ${order.join(', ')}.`
    })

    await check(section, 'collapsing the group of the selected tab keeps its page and its server, marks the header, and keeps the status row', async () => {
      await hub.groupHeader('Tools').locator('.toggle').click()
      await until('Tools expanded', async () => !(await part(hub, 'Tools')).collapsed)
      await hub.select('eta')
      await until('the eta page', async () => (await hits(stubs.eta)) >= 1)
      await sleep(300)
      const before = { shown: await hub.shown(), hits: await hits(stubs.eta), message: await hub.message() }
      await hub.groupHeader('Tools').locator('.toggle').click()
      await until('Tools collapsed', async () => (await part(hub, 'Tools')).collapsed)
      const tools = await part(hub, 'Tools')
      assert.equal(tools.marker, true, 'the selection marker')
      assert.equal(await selectedLabel(hub), 'eta')
      assert.equal((await hub.statusList()).find(({ labels }) => labels.includes('eta'))?.selected, 'eta', 'the status row stays, selected')
      await sleep(500)
      assert.deepEqual(await hub.shown(), before.shown, 'the same page view')
      assert.equal(await hits(stubs.eta), before.hits, 'no reload')
      assert.equal(await hub.message(), before.message)
      assert.ok(isAlive(stubs.eta.child.pid!), 'the server runs')
      await shot('31-group-collapsed-marker.png')
      return `Tools collapsed with the marker. eta stayed selected, its status row stayed and showed as selected, view ${before.shown.visible[0].id} stayed on screen with ${before.hits} page load, and the eta server still ran (screenshot 31-group-collapsed-marker.png).`
    })

    await check(section, 'Enter and Space on a focused header expand and collapse it', async () => {
      const toggle = hub.groupHeader('Tools').locator('.toggle')
      await toggle.focus()
      const controls = await toggle.getAttribute('aria-controls')
      await hub.shell().keyboard.press('Enter')
      await until('Enter expands', async () => !(await part(hub, 'Tools')).collapsed)
      const shown = await hub.shell().evaluate((id) => document.getElementById(id!)!.querySelectorAll('.tab').length, controls)
      await hub.shell().keyboard.press('Space')
      await until('Space collapses', async () => (await part(hub, 'Tools')).collapsed)
      assert.equal(await hub.focusedInShell(), `group:${groupIdOf(hub, 'Tools')}`, 'focus stays on the header')
      await hub.shell().keyboard.press('Space')
      await until('Space expands', async () => !(await part(hub, 'Tools')).collapsed)
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      return `Enter expanded Tools, Space collapsed it, and Space expanded it again. aria-controls names ${controls}, which holds ${shown} rows, and focus stayed on the header.`
    })

    await check(section, 'Ctrl+Tab and Ctrl+Shift+Tab visit each visible top row once in screen order, skip a collapsed group, and never a status row', async () => {
      await hub.groupHeader('Product').locator('.toggle').click()
      await until('Product collapsed', async () => (await part(hub, 'Product')).collapsed)
      const visible = (await hub.topRows()).map(({ label }) => label)
      const statusOrder = (await hub.statusList()).flatMap(({ labels }) => labels)
      await hub.select(visible[0])
      await until('the first row selected', async () => (await selectedLabel(hub)) === visible[0])
      const forward: string[] = []
      for (let step = 0; step < visible.length; step++) {
        await hub.keyTo('sidebar', 'Tab', ['control'])
        const expected = visible[(step + 1) % visible.length]
        await until(`${expected} selected`, async () => (await selectedLabel(hub)) === expected, 3000)
        forward.push(expected)
      }
      const backward: string[] = []
      for (let step = 0; step < visible.length; step++) {
        await hub.keyTo('sidebar', 'Tab', ['control', 'shift'])
        const expected = visible[(visible.length - step - 1) % visible.length]
        await until(`${expected} selected`, async () => (await selectedLabel(hub)) === expected, 3000)
        backward.push(expected)
      }
      assert.equal((await part(hub, 'Product')).collapsed, true, 'Ctrl+Tab does not expand a group')
      return `Visible top rows: ${visible.join(', ')}. Ctrl+Tab went ${forward.join(', ')}. Ctrl+Shift+Tab went ${backward.join(', ')}. The rows of collapsed Product (gamma) were skipped. The Status list order is ${statusOrder.join(', ')}.`
    })

    await check(section, 'with the selected tab in a collapsed group, Ctrl+Tab selects the first visible row and Ctrl+Shift+Tab the last', async () => {
      const results: string[] = []
      for (const [modifiers, end] of [[['control'], 'first'], [['control', 'shift'], 'last']] as const) {
        await hub.groupHeader('Product').locator('.toggle').click()
        await until('Product expanded', async () => !(await part(hub, 'Product')).collapsed)
        await hub.select('gamma')
        await until('gamma selected', async () => (await selectedLabel(hub)) === 'gamma')
        await hub.groupHeader('Product').locator('.toggle').click()
        await until('Product collapsed with the marker', async () => (await part(hub, 'Product')).marker)
        const visible = (await hub.topRows()).map(({ label }) => label)
        const expected = end === 'first' ? visible[0] : visible.at(-1)!
        await hub.keyTo('sidebar', 'Tab', [...modifiers])
        await until(`${expected} selected`, async () => (await selectedLabel(hub)) === expected, 3000)
        assert.equal((await part(hub, 'Product')).collapsed, true)
        results.push(`${modifiers.join('+')}+Tab went to ${expected}, the ${end} visible row`)
      }
      return `With gamma selected in collapsed Product: ${results.join('. ')}. Product stayed collapsed.`
    })

    await check(section, 'a status change with groups moves only the status row: the top list, the page, and the selection stay', async () => {
      await hub.groupHeader('Product').locator('.toggle').click()
      await until('Product expanded', async () => !(await part(hub, 'Product')).collapsed)
      await hub.select('alpha')
      await until('alpha selected', async () => (await selectedLabel(hub)) === 'alpha')
      await until('everyone answered', async () => (await hub.statusList()).every(({ group }) => group !== 'unknown'), NEXT_STATUS_MS)
      await sleep(300)
      const before = { list: await hub.topList(), shown: await hub.shown() }
      await control(stubs.beta, asking(1))
      await until('beta in Needs You', async () => (await hub.groupOf('beta')) === 'needs-you', NEXT_STATUS_MS)
      assert.deepEqual(await hub.topList(), before.list)
      assert.deepEqual(await hub.shown(), before.shown)
      assert.equal(await selectedLabel(hub), 'alpha')
      await shot('33-groups-two-lists.png')
      const status = await hub.statusList()
      await control(stubs.beta, asking(0))
      await until('beta back in Idle', async () => (await hub.groupOf('beta')) === 'idle', NEXT_STATUS_MS)
      return `beta, in Tools, went to Needs You. The top list, the page view, and the selection (alpha) stayed. Status list: ${status.map(({ label, labels }) => `${label} ${labels.join(', ')}`).join('. ')} (screenshot 33-groups-two-lists.png).`
    })

    await check(section, 'the order inside a status group follows the top list, groups first; a drag from a status row or onto the Status list changes nothing', async () => {
      const screenOrder = async () => {
        const liveRoots = new Set((await hub.statusList()).flatMap(({ labels }) => labels))
        const ids = new Map((hub.saved().groups as { id: string; name: string }[]).map(({ id }, index) => [id, index]))
        return hub
          .savedTabs()
          .toSorted((a, b) => (ids.get(a.groupId as string) ?? ids.size) - (ids.get(b.groupId as string) ?? ids.size))
          .map(({ root, name }) => (name as string | null) ?? String(root).split('/').pop()!)
          .filter((label) => liveRoots.has(label))
      }
      const idle = async () => (await hub.statusList()).find(({ group }) => group === 'idle')!.labels
      assert.deepEqual(await idle(), await screenOrder())
      await hub.drag('iota', 'beta', 'top')
      await until('iota in Tools', async () => (await partOfRow(hub, rootOf('iota'))) === 'Tools', 3000)
      await until('Idle follows', async () => (await idle()).join() === (await screenOrder()).join(), 3000)
      const after = await idle()
      const before = { saved: savedText(hub), list: await hub.topList(), status: await hub.statusList() }
      await hub.statusRow('kappa').dragTo(hub.groupHeader('Product'))
      await hub.statusRow('kappa').dragTo(hub.topRow('gamma'), { targetPosition: { x: 40, y: 4 } })
      await hub.topRow('kappa').dragTo(hub.statusRow('alpha'), { targetPosition: { x: 40, y: 4 } })
      await hub.topRow('kappa').dragTo(hub.shell().locator('.status-heading').first())
      await sleep(800)
      assert.equal(savedText(hub), before.saved)
      assert.deepEqual(await hub.topList(), before.list)
      assert.deepEqual(await hub.statusList(), before.status)
      return `After iota moved into Tools, Idle read ${after.join(', ')}, which is the top list's order with Product and Tools first. Drags from the kappa status row onto a header and a top row, and of the kappa top row onto a status row and a status heading, changed nothing.`
    })

    await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1000, 400), null)
    await sleep(500)

    await check(section, 'selecting the status row of a tab in a collapsed group expands it, scrolls its top row into view, shows both rows as selected, and keeps the same page view', async () => {
      for (const name of ['theta', 'kappa', 'delta']) await moveByMenu(hub, rootOf(name), name, 'Tools')
      await hub.select('kappa')
      const opened = await until('the kappa page', async () => (await hub.shown()).visible.find(({ url }) => url.includes(`:${stubs.kappa.port}/`)))
      const pages = (await hub.shown()).pages
      await hub.select('alpha')
      await hub.groupHeader('Tools').locator('.toggle').click()
      await until('Tools collapsed', async () => (await part(hub, 'Tools')).collapsed)
      await hub.shell().evaluate(() => (document.querySelector('#top')!.scrollTop = 0))
      await hub.statusRow('kappa').click()
      await until('Tools expanded', async () => !(await part(hub, 'Tools')).collapsed, 3000)
      await until('kappa selected', async () => (await selectedLabel(hub)) === 'kappa')
      const place = await until('the top row in view', () =>
        hub.shell().evaluate(() => {
          const list = document.querySelector<HTMLElement>('#top')!
          const row = list.querySelector<HTMLElement>('.tab[aria-selected="true"]')!
          const box = row.getBoundingClientRect()
          const frame = list.getBoundingClientRect()
          const inView = box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5
          const neededScroll = box.bottom - frame.top + list.scrollTop > list.clientHeight
          return inView ? { scrollTop: list.scrollTop, neededScroll } : null
        }), 3000)
      assert.equal(place.neededScroll, true, 'the row is below the first screen of the list')
      assert.equal((await hub.statusList()).find(({ labels }) => labels.includes('kappa'))?.selected, 'kappa')
      const after = await hub.shown()
      assert.equal(after.pages, pages, 'no second view')
      assert.deepEqual(after.visible.map(({ id }) => id), [opened.id], 'the same view')
      await shot('34-status-row-reveals.png')
      return `In a 400 px window, a click on the kappa status row expanded Tools, selected kappa in both lists, and scrolled the top list to ${place.scrollTop} px to show the row, which was below the first screen. View ${opened.id} came back with ${pages} views open (screenshot 34-status-row-reveals.png).`
    })

    await check(section, 'with groups and more rows than fit, each list scrolls on its own, and a status change moves neither', async () => {
      const scrolled = await hub.shell().evaluate(() => {
        const top = document.querySelector('#top')!
        const status = document.querySelector('#status')!
        top.scrollTop = 1e6
        status.scrollTop = 40
        return { top: top.scrollTop, status: status.scrollTop, topRoom: top.scrollHeight - top.clientHeight, statusRoom: status.scrollHeight - status.clientHeight }
      })
      assert.ok(scrolled.top > 0 && scrolled.status > 0, JSON.stringify(scrolled))
      await control(stubs.gamma, asking(1))
      await until('gamma in Needs You', async () => (await hub.groupOf('gamma')) === 'needs-you', NEXT_STATUS_MS)
      assert.deepEqual(await hub.scrollTops(), { top: scrolled.top, status: scrolled.status })
      await control(stubs.gamma, asking(0))
      await until('gamma back in Idle', async () => (await hub.groupOf('gamma')) === 'idle', NEXT_STATUS_MS)
      assert.deepEqual(await hub.scrollTops(), { top: scrolled.top, status: scrolled.status })
      return `The top list scrolled to ${scrolled.top} px and the Status list to ${scrolled.status} px, apart. gamma went to Needs You and back, and both positions stayed.`
    })

    await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1400, 900), null)
    await sleep(500)

    await check(section, 'a new live tab goes to the end of Ungrouped and shows under Unknown, at the bottom of the Status list, until its first answer', async () => {
      const lambda = await startStub(home, join(projects, 'lambda'), 0, 'slow-status')
      stubs.lambda = lambda
      await until('lambda', async () => (await part(hub, 'Ungrouped')).labels.at(-1) === 'lambda', NEXT_SCAN_MS)
      const first = await hub.statusList()
      assert.equal(first.at(-1)!.group, 'unknown')
      assert.ok(first.at(-1)!.labels.includes('lambda'))
      assert.equal(await hub.groupOf('Named'), undefined, 'a dimmed tab has no status row')
      await until('lambda answered', async () => (await hub.groupOf('lambda')) === 'idle', NEXT_STATUS_MS)
      return `lambda appeared last in Ungrouped and in Unknown, the last status group (${first.map(({ label }) => label).join(', ')}), then went to Idle after its slow first answer. The dimmed Named tab had no status row.`
    })

    await check(section, 'Rename group (native menu stubbed) keeps the id, uses the same name rule, and returns focus to the menu button', async () => {
      const id = groupIdOf(hub, 'Tools')
      await hub.planMenus(['Rename group'])
      await hub.groupHeader('Tools').locator('.group-menu').click()
      await until('the name dialog', () => dialogOpen(hub))
      assert.equal(await hub.shell().locator('#name-title').innerText(), 'Rename group')
      assert.deepEqual(await hub.shell().locator('#name-input').evaluate((input: HTMLInputElement) => [input.value, input.selectionStart, input.selectionEnd]), ['Tools', 0, 5])
      await typeName(hub, 'product')
      await until('the refusal', async () => (await refusal(hub)) === 'This name is in use.', 2000)
      await typeName(hub, 'Web tools')
      await until('the new name', () => hub.groupHeader('Web tools').count())
      assert.equal(groupIdOf(hub, 'Web tools'), id)
      await until('focus on the menu button', async () => (await hub.focusedInShell()) === `menu:${id}`, 2000)
      return `The dialog opened as Rename group with Tools selected, refused product, and renamed the group to Web tools with the same id ${id}. Focus went back to its menu button.`
    })

    await check(section, 'Remove group asks first (sheet stubbed): Cancel keeps it; Remove moves its tabs to the end of Ungrouped in order, and no server, page, or selection changes', async () => {
      const id = groupIdOf(hub, 'Web tools')
      const members = hub.savedTabs().filter(({ groupId }) => groupId === id).map(({ root }) => String(root))
      const servers = Object.values(stubs).filter(({ child }) => child.exitCode === null && child.signalCode === null).map(({ child }) => child.pid!)
      const before = { shown: await hub.shown(), selected: await selectedLabel(hub), ungrouped: (await part(hub, 'Ungrouped')).labels }
      await hub.planMenus(['Remove group', 'Remove group'])
      await hub.planSheets(['cancel', 'action'])
      await hub.groupHeader('Web tools').locator('.group-menu').click()
      await until('the first sheet', async () => (await hub.sheetsShown()).length === 1)
      await sleep(300)
      assert.ok(await hub.groupHeader('Web tools').count(), 'Cancel keeps the group')
      await hub.groupHeader('Web tools').locator('.group-menu').click()
      await until('Web tools goes', async () => (await hub.groupHeader('Web tools').count()) === 0)
      const sheets = await hub.sheetsShown()
      const asked = { title: 'Remove Web tools?', text: REMOVE_MESSAGE, path: null, buttons: ['Cancel', 'Remove group'], focused: 'sheet-cancel' }
      assert.deepEqual(sheets, [{ ...asked, answer: 'cancel' }, { ...asked, answer: 'action' }])
      const tail = hub.savedTabs().slice(-members.length).map(({ root, groupId }) => [String(root), groupId])
      assert.deepEqual(tail, members.map((root) => [root, null]), 'its tabs are last, in their order, in Ungrouped')
      assert.equal(await selectedLabel(hub), before.selected)
      assert.deepEqual(await hub.shown(), before.shown)
      assert.ok(servers.every(isAlive), 'every server runs')
      assert.equal(await hub.focusedInShell(), 'add')
      return `The sheet asked "Remove Web tools?" and said "${REMOVE_MESSAGE}", with Cancel and Remove group and the keyboard on Cancel. Cancel kept Web tools. Remove put ${members.map((root) => root.split('/').pop()).join(', ')} at the end of Ungrouped in that order. ${servers.length} servers still ran, ${before.selected} stayed selected, and the page view stayed.`
    })

    await check(section, 'native: the real + menu opens with no stub and closes; then focus is on +, nothing changed, and the next + menu works', async () => {
      const before = savedText(hub)
      await hub.planMenus(['real'])
      await hub.shell().locator('#add').click()
      const real = await until('the real menu closes', async () => {
        const menu = (await hub.menusShown()).at(-1)!
        return menu.opened && menu.closed ? menu : null
      }, 3000)
      await sleep(200)
      assert.equal(await hub.focusedInShell(), 'add')
      assert.equal(await dialogOpen(hub), false)
      assert.equal(savedText(hub), before)
      await openNameDialog(hub)
      await hub.shell().keyboard.press('Escape')
      await until('the dialog closes', async () => !(await dialogOpen(hub)))
      return `Menu.popup opened the real native menu with ${JSON.stringify(real.items.map(({ label }) => label))} (menu-will-show fired), and the spy closed it after 400 ms (menu-will-close fired). Then focus was on +, no dialog had opened, tabs.json was the same, and the next + menu opened the dialog. A screenshot cannot show a native menu.`
    })

    await check(section, 'the Remove sheet covers the whole window over the page, and a real Escape answers Cancel and gives the keyboard back', async () => {
      await createGroup(hub, 'Tools')
      await moveByMenu(hub, rootOf('alpha'), 'alpha', 'Tools')
      await hub.planMenus(['Remove group'])
      await hub.planSheets(['hold'])
      await hub.groupHeader('Tools').locator('.group-menu').click()
      await until('the sheet', async () => (await hub.sheetsShown()).length === 3)
      assert.equal(await hub.shellOnTop(), true, 'the shell is over the pages')
      const box = await hub.shell().locator('#sheet .sheet-panel').boundingBox()
      const [width] = await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentSize(), null)
      assert.ok(box && Math.abs(box.x + box.width / 2 - width / 2) < 2, `the panel is centered in the window: ${JSON.stringify(box)}`)
      await shot('groups-remove-sheet.png')
      await hub.shell().keyboard.press('Escape')
      await until('the answer', async () => (await hub.sheetsShown()).at(-1)!.answer === 'cancel', 2000)
      await until('the shell goes back under the pages', async () => !(await hub.shellOnTop()), 2000)
      assert.ok(await hub.groupHeader('Tools').count(), 'the group stays')
      await until('focus on the menu button', async () => (await hub.focusedInShell()) === `menu:${groupIdOf(hub, 'Tools')}`, 2000)
      return `The sheet opened over the page with its panel at ${JSON.stringify(box)} in a ${width} px window. Escape answered Cancel, the shell went back under the page, Tools stayed, and focus went back to its menu button. Screenshot groups-remove-sheet.png`
    })

    await check(section, 'a group header drags before or after another group with its tabs, shows an insertion line on the whole group, and is ignored by tab targets', async () => {
      const groupNames = async () => (await hub.topList()).map(({ name }) => name).filter((name) => name !== UNGROUPED)
      const before = await groupNames()
      assert.ok(before.length >= 2, `two groups: ${before.join()}`)
      const [first, last] = [before[0], before.at(-1)!]
      const tabsOf = async (name: string) => (await part(hub, name)).labels
      const firstTabs = await tabsOf(first)
      const whole = (name: string) => hub.shell().locator('#top .user-group', { has: hub.shell().locator(`.group-header .name:text-is("${name}")`) })
      const lastBox = (await whole(last).boundingBox())!

      const drag = await startDrag(hub, hub.groupHeader(first))
      const anyRow = (await hub.topRows())[0].label
      await drag.over(hub.topRow(anyRow), 4)
      const onRow = await hub.shell().locator('.tab.drop-before, .tab.drop-after, .drop-into').count()
      await drag.over(whole(last), lastBox.height - 4)
      const line = await whole(last).evaluate((item) => [item.classList.contains('drop-after'), getComputedStyle(item).boxShadow !== 'none'])
      await shot('groups-drag-group.png')
      await drag.end('drop')
      const after = [...before.slice(1), first]
      await until(`${first} after ${last}`, async () => (await groupNames()).join() === after.join(), 3000)
      assert.equal(onRow, 0, 'a row and a header show no tab mark for a group drag')
      assert.deepEqual(line, [true, true], 'the insertion line under the last group')
      assert.deepEqual(await tabsOf(first), firstTabs, 'the tabs go with the group')
      assert.deepEqual(hub.saved().groups.map(({ name }) => name), after, 'tabs.json has the new order')
      assert.equal(await hub.shell().locator('.drop-before, .drop-after, .drop-into').count(), 0, 'no mark after the drop')

      const back = await startDrag(hub, hub.groupHeader(first))
      await back.over(whole(before[1]), 4)
      await back.end('drop')
      await until(`${first} first again`, async () => (await groupNames()).join() === before.join(), 3000)
      const unchanged = savedText(hub)
      const ignored = await startDrag(hub, hub.groupHeader(first))
      await ignored.over(hub.shell().locator('#top .group-header.ungrouped'), 10)
      await ignored.end('drop')
      await sleep(600)
      assert.equal(savedText(hub), unchanged, 'a drop on Ungrouped changes nothing')
      return `Over a row, no tab mark showed. Over the lower part of ${last}, the whole group had the insertion line (screenshot groups-drag-group.png). The drop made the order ${after.join(', ')}, with ${first} keeping ${firstTabs.join(', ') || 'no tabs'}, and tabs.json saved it. A drop on the top part of ${before[1]} put ${first} back first. A drop on Ungrouped changed nothing.`
    })

    await check(section, 'quit and reopen: groups, names, membership, order, and collapsed states are the same', async () => {
      await hub.groupHeader('Product').locator('.toggle').click()
      await until('Product collapsed', async () => (await part(hub, 'Product')).collapsed)
      const before = await hub.topList()
      const saved = hub.saved()
      await hub.quit()
      hub = await Hub.launch(home, userData)
      await until('the same top list', async () => JSON.stringify(await hub.topList()) === JSON.stringify(before), 5000)
      assert.deepEqual(hub.saved().groups, saved.groups)
      return `After a restart: ${before.map(({ name, collapsed, count, labels }) => `${name}${collapsed ? ' (collapsed)' : ''} ${count ?? ''}: ${labels.join(', ')}`).join('. ')}.`
    })
  } finally {
    await hub.quit()
    for (const stub of Object.values(stubs)) await stub.stop()
  }

  await check(section, 'with no visible top row, Ctrl+Tab and Ctrl+Shift+Tab change nothing, and the first selection does not expand the group', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const projects = tempDir('projects')
    const [a, b] = [await startStub(home, join(projects, 'alpha')), await startStub(home, join(projects, 'beta'))]
    mkdirSync(userData, { recursive: true })
    const tabs = [a, b].map(({ root }) => ({ root, name: null, groupId: 'only' }))
    writeFileSync(join(userData, 'tabs.json'), JSON.stringify({ groups: [{ id: 'only', name: 'Only', collapsed: true }], tabs }))
    const hub = await Hub.launch(home, userData)
    try {
      const selected = await until('a selected tab', () => selectedLabel(hub))
      await until('its page with its address', async () => { const { visible } = await hub.shown(); return visible.length === 1 && visible[0].url.startsWith('http') })
      const only = await part(hub, 'Only')
      assert.deepEqual([only.collapsed, only.marker, (await hub.topRows()).length], [true, true, 0])
      const page = async () => (await hub.shown()).visible.map(({ id, url }) => ({ id, url }))
      const shown = await page()
      for (const modifiers of [['control'], ['control', 'shift']]) {
        await hub.keyTo('sidebar', 'Tab', modifiers)
        await sleep(400)
        assert.equal(await selectedLabel(hub), selected)
        assert.deepEqual(await page(), shown)
      }
      assert.equal((await part(hub, 'Only')).collapsed, true)
      return `Both tabs are in the collapsed group Only. The app selected ${selected} at launch and kept Only collapsed with the marker. Ctrl+Tab and Ctrl+Shift+Tab kept ${selected} and its page.`
    } finally {
      await hub.quit()
      await a.stop()
      await b.stop()
    }
  })

  await check(section, 'saved: the old array tabs.json reads as corrupt: hub.log names it, the names are gone, and the next save writes { groups, tabs }', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const a = await startStub(home, join(tempDir('projects'), 'alpha'))
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'tabs.json'), JSON.stringify([{ root: a.root, name: 'Website' }]))
    const hub = await Hub.launch(home, userData)
    try {
      await until('alpha', () => hub.tab('alpha'))
      assert.equal(await hub.tab('Website'), undefined)
      assert.ok(hub.log().includes('tabs.json'), hub.log())
      await until('the new shape', () => Array.isArray(hub.saved().groups))
      assert.deepEqual(hub.saved(), { groups: [], tabs: [{ root: a.root, name: null, groupId: null, lifecycle: null }], zoom: 1, sidebar: 'full' })
      return `The array with "Website" gave a log line (${hub.log().trim().split('\n').at(-1)}). alpha showed with its folder name, and tabs.json became { groups: [], tabs: [alpha], zoom: 1, sidebar: 'full' }.`
    } finally {
      await hub.quit()
      await a.stop()
    }
  })
}
