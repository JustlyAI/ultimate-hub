import type { Hub } from '../preload'
import type { MenuChoice, Point } from '../shared/menu'
import {
  groupNameRefusal,
  PANEL_GAP,
  sidebarWidth,
  UNGROUPED,
  type GroupId,
  type GroupView,
  type MainArea,
  type Row,
  type RowLifecycle,
  type Sidebar,
  type SidebarForm,
  type StatusSection,
} from '../shared/tabs'
import { askName } from './name-dialog'
import { showSheet } from './sheet'
import { renderRail, revealRailSelection } from './rail'
import { openSearch, refreshSearch } from './search'

declare const hub: Hub

document.documentElement.style.setProperty('--panel-gap', `${PANEL_GAP}px`)

// macOS's default double-click time. A double-click starts a rename, so its second click must land on the same row.
const DOUBLE_CLICK_MS = 500
// A group id is a UUID, so it never equals this choice in Move to group.
const UNGROUPED_CHOICE = 'ungrouped'
const RENAME_CHOICE = 'rename'
const CLOSE_CHOICE = 'close'
const REMOVE_CHOICE = 'remove'
const REMOVE_MESSAGE = 'Instances move to Ungrouped. Their servers keep running.'

const sidebar = document.querySelector<HTMLElement>('#sidebar')!
const top = document.querySelector<HTMLUListElement>('#top')!
const status = document.querySelector<HTMLUListElement>('#status')!
const message = document.querySelector<HTMLElement>('#message')!
const add = document.querySelector<HTMLButtonElement>('#add')!
const searchButton = document.querySelector<HTMLButtonElement>('#search-open')!
const terminalButton = document.querySelector<HTMLButtonElement>('#terminal-toggle')!
const split = document.querySelector<HTMLElement>('#split')!
const sidebarToggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!

let current: Parameters<typeof render> = [{ form: 'full', groups: [], ungrouped: [], status: [] }, { kind: 'empty' }]
let revealed: string | undefined
// A new state must not destroy a row while the user drags or renames it. It waits until they finish.
let busy = false
let pressedAt = 0
let arranged = ''
let newGroupFocusKey: string | null = null
let pendingRevealRoot: string | null = null
// A press on a row's button must not start a drag of the row.
let controlPressed = false
window.addEventListener('mouseup', () => (controlPressed = false), true)

// Collapse is not part of it, so the user's own click on a header never waits.
const arrangementOf = (view: Sidebar) =>
  JSON.stringify([
    view.groups.map(({ id, rows }) => [id, rows.map(({ root }) => root)]),
    view.ungrouped.map(({ root }) => root),
    view.status.map(({ kind, rows }) => [kind, rows.map(({ root }) => root)]),
  ])

hub.onState((view, main) => {
  showForm(view.form)
  current = [view, main]
  refreshSearch(view)
  show()
})

sidebarToggle.addEventListener('click', () => hub.send({ type: 'toggle-sidebar' }))

/** Not held during a drag or a rename, because the main process has already moved the pages. */
function showForm(form: SidebarForm) {
  const rail = form === 'rail'
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth(form)}px`)
  if (sidebar.classList.contains('rail') === rail) return
  // Each form hides the other's controls, so the keyboard goes to the one that stays.
  if (sidebar.contains(document.activeElement)) sidebarToggle.focus()
  sidebar.classList.toggle('rail', rail)
  // The next render shows the selected row or tile of the new form.
  revealed = undefined
  const name = rail ? 'Show sidebar' : 'Hide sidebar'
  sidebarToggle.ariaLabel = name
  sidebarToggle.title = `${name} (⇧⌘B)`
  sidebarToggle.ariaExpanded = String(!rail)
}
showForm('full')

searchButton.addEventListener('click', () => hub.openSearch())
terminalButton.addEventListener('click', () => hub.toggleTerminal())
hub.onSheet(async (sheet) => {
  const before = document.activeElement as HTMLElement | null
  const key = before?.dataset.focus
  const yes = await showSheet(sheet)
  // A scan can replace the element while the sheet is open, so the one with the same key takes focus.
  if (before && !before.isConnected && key) focusKey(key, false)
  hub.answerSheet(yes)
})
hub.onSearch((fromPage) => {
  const before = fromPage ? null : (document.activeElement as HTMLElement | null)
  const key = before?.dataset.focus
  openSearch(current[0], {
    cancelled() {
      // A scan can replace the element, so the one with the same key takes focus.
      if (before?.isConnected) before.focus({ preventScroll: true })
      else if (key) focusKey(key, false)
    },
    chosen(root) {
      pendingRevealRoot = root
      revealPending()
    },
  })
})

hub.onPanel((height) => {
  split.hidden = height === 0
  const name = height === 0 ? 'Show terminal' : 'Hide terminal'
  terminalButton.ariaLabel = name
  terminalButton.title = `${name} (⌃\`)`
  terminalButton.ariaPressed = String(height > 0)
  document.documentElement.style.setProperty('--panel-height', `${height}px`)
  document.documentElement.style.setProperty('--panel-space', height === 0 ? '0px' : `${height + PANEL_GAP}px`)
})

split.addEventListener('pointerdown', (event) => {
  split.setPointerCapture(event.pointerId)
  const drag = (move: PointerEvent) => hub.resizePanel(window.innerHeight - move.clientY - PANEL_GAP / 2)
  split.addEventListener('pointermove', drag)
  split.addEventListener(
    'lostpointercapture',
    () => {
      split.removeEventListener('pointermove', drag)
      hub.endPanelDrag()
    },
    { once: true },
  )
})

function show() {
  if (busy) return
  const wait = pressedAt + DOUBLE_CLICK_MS - Date.now()
  if (wait > 0 && arrangementOf(current[0]) !== arranged) setTimeout(show, wait)
  else render(...current)
}

// Ending a rename rebuilds the rows while the mouse is down, so the row under it would never get its click.
sidebar.addEventListener('mousedown', (event) => {
  pressedAt = Date.now()
  if (!top.querySelector('.rename')) return
  const row = (event.target as Element).closest<HTMLElement>('.tab')
  if (row && !row.querySelector('.rename')) hub.send({ type: 'select', root: row.dataset.root! })
})

add.addEventListener('click', async () => {
  const choice = await hub.pick([{ id: 'ultimate', label: 'Ultimate' }, { id: 'group', label: 'Group' }], below(add))
  if (choice === 'group') await createGroup()
  else if (choice !== 'ultimate' || !(await hub.addUltimate())) add.focus()
})

function finish() {
  busy = false
  render(...current)
}

function render(view: Sidebar, main: MainArea) {
  arranged = arrangementOf(view)
  // With no selected tab there is no shell to show.
  terminalButton.disabled = main.kind === 'empty'
  // A status answer rebuilds both lists, so focus moves to the new element with the same key.
  const focused = (document.activeElement as HTMLElement | null)?.dataset.focus
  top.replaceChildren(
    ...view.groups.map(groupItem),
    ...(view.groups.length > 0 ? [ungroupedHeader(view.ungrouped.length)] : []),
    ...view.ungrouped.map((row) => topRow(row, null)),
  )
  status.replaceChildren(...view.status.flatMap((section) => [heading(section), ...section.rows.map(statusRow)]))
  renderRail(view)
  if (focused && document.hasFocus()) focusKey(focused, false)
  if (newGroupFocusKey && focusKey(newGroupFocusKey, true)) newGroupFocusKey = null
  revealNewSelection(view)
  revealPending()
  showMessage(main)
}

const MESSAGE: Record<Exclude<RowLifecycle, 'running'>, (label: string) => string> = {
  stopped: (label) => `${label} is not running`,
  paused: () => 'Paused',
  stopping: () => 'Stopping…',
  closing: () => 'Closing…',
  starting: () => 'Starting…',
}

function showMessage(main: MainArea) {
  if (main.kind !== 'message') {
    message.replaceChildren(main.kind === 'empty' ? 'No Ultimate running' : '')
    return
  }
  const parts: HTMLElement[] = [span('notice', MESSAGE[main.lifecycle](main.label))]
  if (main.error) {
    const error = span('error', main.error)
    error.role = 'alert'
    parts.push(error)
  }
  if (main.error && main.lifecycle === 'paused') {
    const retry = document.createElement('button')
    retry.className = 'retry'
    retry.textContent = 'Start'
    retry.ariaLabel = `Start ${main.label}`
    retry.addEventListener('click', () => hub.lifecycle(main.root, 'play'))
    parts.push(retry)
  }
  message.replaceChildren(...parts)
}

/** A scan must not undo the user's scrolling. */
function revealNewSelection(view: Sidebar) {
  const selected = [...view.groups.flatMap(({ rows }) => rows), ...view.ungrouped].find((row) => row.selected)?.root
  if (selected === revealed) return
  for (const list of [top, status]) list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  revealRailSelection()
  revealed = selected
}

function revealPending() {
  const row = pendingRevealRoot === null ? null : top.querySelector<HTMLElement>(`.tab[data-root="${CSS.escape(pendingRevealRoot)}"]`)
  if (!row || row.closest('[hidden]')) return
  row.scrollIntoView({ block: 'nearest' })
  pendingRevealRoot = null
}

function focusKey(key: string, scroll: boolean): boolean {
  const match = sidebar.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)
  // A control that is busy cannot take focus, so its row takes it.
  const found = match instanceof HTMLButtonElement && match.disabled ? match.closest<HTMLElement>('.tab') : match
  // A row in a collapsed group cannot take focus, so its group's header takes it.
  const element = found?.closest('[hidden]') ? found.closest('.user-group')!.querySelector<HTMLElement>('.toggle') : found
  if (!element) return false
  if (scroll) element.scrollIntoView({ block: 'nearest' })
  element.focus({ preventScroll: true })
  return true
}

const below = (element: HTMLElement): Point => {
  const { left, bottom } = element.getBoundingClientRect()
  return { x: left, y: bottom + 2 }
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

function heading({ kind, label, rows }: StatusSection): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'status-heading'
  item.role = 'presentation'
  item.dataset.kind = kind
  item.append(span('', label), span('count', String(rows.length)))
  return item
}

// A tab drag carries the tab's root as text. A group drag carries the group's id as this type, so each drop target can tell them apart.
const GROUP_DRAG = 'application/x-hub-group'
const isGroupDrag = (event: DragEvent) => event.dataTransfer!.types.includes(GROUP_DRAG)

function groupItem(group: GroupView): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'user-group'
  item.role = 'presentation'

  const header = document.createElement('div')
  header.className = 'group-header'
  header.draggable = true
  header.addEventListener('dragstart', (event) => {
    busy = true
    event.dataTransfer!.setData(GROUP_DRAG, group.id)
    event.dataTransfer!.effectAllowed = 'move'
  })
  header.addEventListener('dragend', finish)
  // The whole group, header and rows, is the target, so a drop in its lower half goes after its last row.
  item.addEventListener('dragover', (event) => {
    if (!isGroupDrag(event)) return
    event.preventDefault()
    clearMarker(item)
    item.classList.add(inLowerHalf(event, item) ? 'drop-after' : 'drop-before')
  })
  item.addEventListener('dragleave', (event) => {
    if (!item.contains(event.relatedTarget as Node | null)) clearMarker(item)
  })
  item.addEventListener('drop', (event) => {
    if (!isGroupDrag(event)) return
    event.preventDefault()
    clearMarker(item)
    const id = event.dataTransfer!.getData(GROUP_DRAG) as GroupId
    hub.send({ type: 'move-group', id, target: group.id, place: inLowerHalf(event, item) ? 'after' : 'before' })
  })
  const toggle = document.createElement('button')
  toggle.className = 'toggle'
  toggle.ariaExpanded = String(!group.collapsed)
  toggle.setAttribute('aria-controls', `rows-${group.id}`)
  toggle.dataset.focus = `group:${group.id}`
  toggle.append(span('chevron', '›'), span('name', group.name))
  toggle.addEventListener('click', () => hub.send({ type: 'collapse-group', id: group.id, collapsed: !group.collapsed }))
  header.append(toggle)
  if (group.hidesSelected) {
    const marker = span('marker', '●')
    marker.role = 'img'
    marker.ariaLabel = 'Selected'
    header.append(marker)
  }
  const menu = document.createElement('button')
  menu.className = 'group-menu'
  menu.ariaLabel = `${group.name} menu`
  menu.ariaHasPopup = 'menu'
  menu.dataset.focus = `menu:${group.id}`
  menu.textContent = '⋯'
  menu.addEventListener('click', () => groupMenu(group.id, below(menu)))
  header.append(span('count', String(group.count)), menu)
  dropInto(header, group.id)

  const rows = document.createElement('ul')
  rows.className = 'group-rows'
  rows.id = `rows-${group.id}`
  rows.role = 'presentation'
  rows.hidden = group.collapsed
  rows.append(...group.rows.map((row) => topRow(row, group.id)))
  item.append(header, rows)
  return item
}

function ungroupedHeader(count: number): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'group-header ungrouped'
  item.role = 'presentation'
  item.append(span('name', UNGROUPED), span('count', String(count)))
  dropInto(item, null)
  return item
}

function dropInto(header: HTMLElement, groupId: GroupId | null) {
  header.addEventListener('dragover', (event) => {
    if (isGroupDrag(event)) return
    event.preventDefault()
    header.classList.add('drop-into')
  })
  header.addEventListener('dragleave', (event) => {
    if (!header.contains(event.relatedTarget as Node | null)) header.classList.remove('drop-into')
  })
  header.addEventListener('drop', (event) => {
    if (isGroupDrag(event)) return
    event.preventDefault()
    header.classList.remove('drop-into')
    hub.send({ type: 'move-to-group', root: event.dataTransfer!.getData('text/plain'), groupId })
  })
}

async function createGroup() {
  const name = await askName({
    title: 'New group',
    action: 'Create group',
    initial: '',
    refusalOf: (name) => groupNameRefusal(current[0].groups, name),
  })
  if (name === null) return add.focus()
  const id = crypto.randomUUID() as GroupId
  newGroupFocusKey = `group:${id}`
  hub.send({ type: 'create-group', id, name })
}

async function groupMenu(id: GroupId, at: Point) {
  const choice = await hub.pick([{ id: 'rename', label: 'Rename group' }, { id: 'remove', label: 'Remove group' }], at)
  const group = current[0].groups.find((candidate) => candidate.id === id)
  if (group && choice === 'rename') {
    const name = await askName({
      title: 'Rename group',
      action: 'Rename group',
      initial: group.name,
      refusalOf: (name) => groupNameRefusal(current[0].groups, name, id),
    })
    if (name !== null && name !== group.name) hub.send({ type: 'rename-group', id, name })
  }
  if (group && choice === 'remove' && (group.count === 0 || (await hub.ask({ icon: 'remove', title: `Remove ${group.name}?`, text: REMOVE_MESSAGE, path: null, action: 'Remove group' })))) {
    hub.send({ type: 'remove-group', id })
    return add.focus()
  }
  focusKey(`menu:${id}`, false)
}

/** Rename, Close or Remove, then Move to group when the user has groups. The trailing button, a right-click, and Shift+F10 open it. */
async function rowMenu(row: Row, from: GroupId | null, at: Point) {
  const { groups } = current[0]
  const first: MenuChoice =
    row.lifecycle === 'running'
      ? { id: CLOSE_CHOICE, label: 'Close Ultimate…' }
      : { id: REMOVE_CHOICE, label: 'Remove from Hub', enabled: row.lifecycle === 'paused' || row.lifecycle === 'stopped' }
  const choice = await hub.pick(
    [
      { id: RENAME_CHOICE, label: 'Rename' },
      first,
      ...(groups.length === 0
        ? []
        : [
            { heading: 'Move to group' },
            ...groups.map(({ id, name }) => ({ id, label: name, checked: id === from })),
            { id: UNGROUPED_CHOICE, label: UNGROUPED, checked: from === null },
          ]),
    ],
    at,
  )
  if (choice === RENAME_CHOICE) rename(row.root)
  else if (choice === CLOSE_CHOICE) hub.lifecycle(row.root, 'close')
  else if (choice === REMOVE_CHOICE) hub.send({ type: 'remove', root: row.root })
  else if (choice !== null) hub.send({ type: 'move-to-group', root: row.root, groupId: choice === UNGROUPED_CHOICE ? null : (choice as GroupId) })
}

function rowElement(row: Row, role: 'tab' | 'option'): HTMLLIElement {
  const item = document.createElement('li')
  item.className = row.lifecycle === 'paused' || row.lifecycle === 'stopped' ? 'tab dimmed' : 'tab'
  item.role = role
  item.ariaSelected = String(row.selected)
  item.title = row.root
  item.dataset.root = row.root
  item.append(span('label', row.label))
  if (row.error) {
    const mark = span('error-mark', '!')
    mark.role = 'img'
    mark.ariaLabel = row.error
    mark.title = row.error
    item.append(mark)
  }
  if (row.lifecycle === 'paused') item.append(span('state', 'Paused'))
  else if (row.port !== null) item.append(span('port', String(row.port)))
  item.addEventListener('click', () => hub.send({ type: 'select', root: row.root }))
  return item
}

function statusRow(row: Row): HTMLLIElement {
  const item = rowElement(row, 'option')
  item.addEventListener('click', () => {
    pendingRevealRoot = row.root
    revealPending()
  })
  return item
}

function topRow(row: Row, groupId: GroupId | null): HTMLLIElement {
  const item = rowElement(row, 'tab')
  item.draggable = true
  // Move to group must work from the keyboard, so the row takes focus.
  item.tabIndex = 0
  item.dataset.focus = `row:${row.root}`

  const life = lifecycleButton(row)
  const menu = control('row-menu', `${row.label} menu`, `rowmenu:${row.root}`)
  menu.ariaHasPopup = 'menu'
  menu.textContent = '⋯'
  menu.addEventListener('click', () => rowMenu(row, groupId, below(menu)))
  item.append(...(life ? [life] : []), menu)

  item.addEventListener('dblclick', (event) => {
    if (!(event.target as Element).closest('button')) rename(row.root)
  })
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void rowMenu(row, groupId, { x: event.clientX, y: event.clientY })
  })
  item.addEventListener('keydown', (event) => {
    if (event.target !== item || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
    event.preventDefault()
    void rowMenu(row, groupId, below(item.querySelector<HTMLElement>('.label')!))
  })
  item.addEventListener('dragstart', (event) => {
    if (controlPressed) return event.preventDefault()
    busy = true
    event.dataTransfer!.setData('text/plain', row.root)
    event.dataTransfer!.effectAllowed = 'move'
  })
  item.addEventListener('dragend', finish)
  item.addEventListener('dragover', (event) => {
    if (isGroupDrag(event)) return
    event.preventDefault()
    clearMarker(item)
    item.classList.add(inLowerHalf(event, item) ? 'drop-after' : 'drop-before')
  })
  item.addEventListener('dragleave', () => clearMarker(item))
  item.addEventListener('drop', (event) => {
    if (isGroupDrag(event)) return
    event.preventDefault()
    clearMarker(item)
    const root = event.dataTransfer!.getData('text/plain')
    hub.send({ type: 'move', root, target: row.root, place: inLowerHalf(event, item) ? 'after' : 'before' })
  })
  return item
}

/** A native button that acts on its row without selecting it. */
function control(className: string, name: string, focus: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = className
  button.ariaLabel = name
  button.title = name
  button.dataset.focus = focus
  button.addEventListener('mousedown', () => (controlPressed = true))
  button.addEventListener('click', (event) => event.stopPropagation())
  return button
}

const ICON = {
  pause: '<rect x="3" y="2.5" width="3" height="9" rx="0.8"/><rect x="8" y="2.5" width="3" height="9" rx="0.8"/>',
  play: '<path d="M4 2.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z"/>',
  busy: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="18 10"/>',
}

const BUSY: Partial<Record<RowLifecycle, string>> = { stopping: 'Stopping', closing: 'Closing', starting: 'Starting' }

/** Pause on a running row, Start on a paused row, and a disabled progress indicator while Hub acts. */
function lifecycleButton(row: Row): HTMLButtonElement | null {
  const progress = BUSY[row.lifecycle]
  const kind = row.lifecycle === 'running' ? 'pause' : row.lifecycle === 'paused' ? 'play' : progress ? 'busy' : null
  if (kind === null) return null
  const name = kind === 'pause' ? `Pause ${row.label}` : kind === 'play' ? `Start ${row.label}` : `${progress} ${row.label}`
  const button = control(`life ${kind}`, name, `life:${row.root}`)
  button.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor" aria-hidden="true">${ICON[kind]}</svg>`
  if (kind === 'busy') button.disabled = true
  else button.addEventListener('click', () => hub.lifecycle(row.root, kind))
  return button
}

function inLowerHalf(event: DragEvent, item: HTMLElement) {
  const { top, height } = item.getBoundingClientRect()
  return event.clientY > top + height / 2
}

function clearMarker(item: HTMLElement) {
  item.classList.remove('drop-before', 'drop-after')
}

/** The row menu can return after a new state rebuilt the rows, so this finds the row again. */
function rename(root: string) {
  const item = top.querySelector<HTMLLIElement>(`.tab[data-root="${CSS.escape(root)}"]`)
  const tab = [...current[0].groups.flatMap(({ rows }) => rows), ...current[0].ungrouped].find((row) => row.root === root)
  if (!item || !tab) return
  const label = item.querySelector<HTMLElement>('.label')!
  busy = true
  item.draggable = false
  const input = document.createElement('input')
  input.className = 'rename'
  input.ariaLabel = `Rename ${tab.label}`
  // Enter rebuilds the rows, and the focus key moves focus to the new row.
  input.dataset.focus = `row:${root}`
  input.value = tab.label
  let done = false
  const end = (commit: boolean) => {
    if (done) return
    done = true
    if (commit && input.value !== tab.label) hub.send({ type: 'rename', root: tab.root, name: input.value })
    finish()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') end(true)
    if (event.key === 'Escape') end(false)
  })
  input.addEventListener('blur', () => end(true))
  input.addEventListener('click', (event) => event.stopPropagation())
  input.addEventListener('dblclick', (event) => event.stopPropagation())
  label.replaceWith(input)
  input.focus()
  input.select()
}
