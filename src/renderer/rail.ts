import type { Hub } from '../preload'
import { STATUS_ORDER, type GroupView, type Row, type RowLifecycle, type Sidebar, type StatusKind } from '../shared/tabs'

declare const hub: Hub

const list = document.querySelector<HTMLUListElement>('#rail')!
const above = document.querySelector<HTMLElement>('#rail-above')!
const below = document.querySelector<HTMLElement>('#rail-below')!

const LABEL = Object.fromEntries(STATUS_ORDER.map(({ kind, label }) => [kind, label])) as Record<StatusKind, string>
const LIFECYCLE: Record<Exclude<RowLifecycle, 'running'>, string> = {
  stopped: 'Not running',
  paused: 'Paused',
  stopping: 'Stopping…',
  closing: 'Closing…',
  starting: 'Starting…',
}
// The edge markers count only these, because only these ask the user to act.
const URGENT: readonly StatusKind[] = ['needs-you', 'failed']
// A tile whose middle is under an edge marker counts as out of view.
const EDGE_PX = 22

// A menu pick rebuilds the rail, so the key of the element that takes the keyboard waits for the next render.
let focusAfterRender: string | null = null

list.addEventListener('scroll', showEdges)
new ResizeObserver(showEdges).observe(list)

export function renderRail(view: Sidebar) {
  const items: HTMLLIElement[] = []
  for (const group of view.groups) {
    if (group.collapsed) items.push(stack(group))
    else items.push(caption(group.name), ...group.rows.map((row) => tile(row, group.name)))
  }
  if (view.groups.length > 0 && view.ungrouped.length > 0) items.push(caption(''))
  items.push(...view.ungrouped.map((row) => tile(row, null)))
  list.replaceChildren(...items)
  if (focusAfterRender) list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusAfterRender)}"]`)?.focus({ preventScroll: true })
  focusAfterRender = null
  showEdges()
}

export function revealRailSelection() {
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

/** Two letters for a tile: the first letters of the first two words, or the first two letters of one word. */
export function initialsOf(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return [...label].slice(0, 2).join('')
  if (words.length === 1) {
    const [first = '', second = ''] = [...words[0]]
    return first.toUpperCase() + second
  }
  return ([...words[0]][0] + [...words[1]][0]).toUpperCase()
}

function caption(name: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'rail-caption'
  item.role = 'presentation'
  item.textContent = name
  return item
}

function face(text: string, dot: StatusKind | 'error' | null): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'face'
  element.textContent = text
  if (dot) {
    const mark = document.createElement('i')
    mark.className = `dot ${dot}`
    element.append(mark)
  }
  return element
}

function short(text: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'short'
  element.textContent = text
  return element
}

function tile(row: Row, group: string | null): HTMLLIElement {
  const item = document.createElement('li')
  const dimmed = row.lifecycle === 'paused' || row.lifecycle === 'stopped'
  item.className = dimmed ? 'rail-tile dimmed' : 'rail-tile'
  item.role = 'tab'
  item.tabIndex = 0
  item.ariaSelected = String(row.selected)
  item.dataset.root = row.root
  item.dataset.focus = `rail:${row.root}`
  const state = row.status ? LABEL[row.status] : LIFECYCLE[row.lifecycle as Exclude<RowLifecycle, 'running'>]
  const name = [row.label, state, group].filter(Boolean).join(' · ')
  item.ariaLabel = row.error ? `${name}. ${row.error}` : name
  item.title = row.error ? `${name}\n${row.error}` : name
  if (row.status && URGENT.includes(row.status)) item.dataset.urgent = row.status
  item.append(face(initialsOf(row.label), row.error ? 'error' : row.status === 'idle' ? null : row.status), short(row.label))
  const select = () => hub.send({ type: 'select', root: row.root })
  item.addEventListener('click', select)
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    select()
  })
  return item
}

/** A collapsed group: one tile with its count and its most urgent status. It opens a menu of its tabs. */
function stack(group: GroupView): HTMLLIElement {
  const item = document.createElement('li')
  const dimmed = group.rows.every((row) => row.lifecycle === 'paused' || row.lifecycle === 'stopped')
  item.className = dimmed ? 'rail-tile stack dimmed' : 'rail-tile stack'
  item.role = 'tab'
  item.tabIndex = 0
  item.ariaSelected = String(group.hidesSelected)
  item.ariaHasPopup = 'menu'
  item.dataset.group = group.id
  item.dataset.focus = `railgroup:${group.id}`
  const name = [group.name, `${group.count} ${group.count === 1 ? 'tab' : 'tabs'}`, group.status ? LABEL[group.status] : null].filter(Boolean).join(' · ')
  item.ariaLabel = name
  item.title = name
  // A marker counts each urgent status that the group holds, not only its most urgent one.
  const urgent = URGENT.filter((kind) => group.rows.some((row) => row.status === kind))
  if (urgent.length > 0) item.dataset.urgent = urgent.join(' ')
  const count = document.createElement('b')
  count.className = 'count'
  count.textContent = String(group.count)
  const groupFace = face(initialsOf(group.name), group.status)
  groupFace.append(count)
  item.append(groupFace, short(group.name))
  const open = async () => {
    const { right, top } = item.getBoundingClientRect()
    const choice = await hub.pick(
      group.rows.map((row) => ({
        id: row.root,
        label: row.status && row.status !== 'idle' ? `${row.label} · ${LABEL[row.status]}` : row.label,
        checked: row.selected,
      })),
      { x: right, y: top },
    )
    focusAfterRender = choice === null ? null : `rail:${choice}`
    if (choice !== null) hub.send({ type: 'select', root: choice })
    // A status answer can replace the tile while the menu is open.
    else list.querySelector<HTMLElement>(`[data-focus="railgroup:${CSS.escape(group.id)}"]`)?.focus({ preventScroll: true })
  }
  item.addEventListener('click', open)
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void open()
  })
  return item
}

/** A marker at each edge for urgent tiles out of view there. A click scrolls to the nearest one and gives it the keyboard. */
function showEdges() {
  // The full sidebar hides the rail, and a hidden list has no geometry.
  if (list.clientHeight === 0) {
    above.hidden = below.hidden = true
    return
  }
  for (const [edge, side] of [[above, 'above'], [below, 'below']] as const) {
    const counts = URGENT.map((kind) => [kind, outOfView(side, kind).length] as const).filter(([, count]) => count > 0)
    const shown = counts.map(([kind, count]) => `${kind}:${count}`).join(' ')
    // Rebuilding on each scroll would take the keyboard from a focused marker.
    if (edge.dataset.shown === shown) continue
    edge.dataset.shown = shown
    const focused = edge.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : null
    edge.replaceChildren(...counts.map(([kind, count]) => marker(side, kind, count)))
    edge.querySelector<HTMLElement>(`button.${focused}`)?.focus({ preventScroll: true })
    edge.hidden = counts.length === 0
  }
}

/** The urgent tiles of one kind out of view at one edge, nearest first. */
function outOfView(side: 'above' | 'below', kind: StatusKind): HTMLElement[] {
  const box = list.getBoundingClientRect()
  const items = [...list.querySelectorAll<HTMLElement>('[data-urgent]')].filter((item) => {
    if (!item.dataset.urgent!.split(' ').includes(kind)) return false
    const { top, height } = item.getBoundingClientRect()
    const middle = top + height / 2
    return side === 'above' ? middle < box.top + EDGE_PX : middle > box.bottom - EDGE_PX
  })
  return side === 'above' ? items.reverse() : items
}

function marker(side: 'above' | 'below', kind: StatusKind, count: number): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = kind
  button.textContent = `${side === 'above' ? '↑' : '↓'} ${count}`
  button.ariaLabel = `${count} ${LABEL[kind]} ${side}`
  button.title = button.ariaLabel
  button.addEventListener('click', () => {
    const [nearest] = outOfView(side, kind)
    if (!nearest) return
    nearest.scrollIntoView({ block: 'center' })
    nearest.focus({ preventScroll: true })
  })
  return button
}
