import type { Hub } from '../preload'
import { activeAfter, searchOf, type SearchResult, type Sidebar, type Span } from '../shared/tabs'

declare const hub: Hub

// A screen reader hears the count once the typing pauses, not at each key press.
const ANNOUNCE_AFTER_MS = 500

const dialog = document.querySelector<HTMLDialogElement>('#search')!
const input = dialog.querySelector<HTMLInputElement>('#search-input')!
const list = dialog.querySelector<HTMLUListElement>('#search-results')!
const empty = dialog.querySelector<HTMLElement>('#search-empty')!
const count = dialog.querySelector<HTMLElement>('#search-count')!

type Ending = { cancelled(): void; chosen(root: string): void }

let sidebar: Sidebar = { form: 'full', groups: [], ungrouped: [], status: [] }
let results: SearchResult[] = []
let active: string | null = null
let ending: Ending | null = null
let announcing: ReturnType<typeof setTimeout> | undefined

export function openSearch(view: Sidebar, end: Ending) {
  if (dialog.open) return input.focus()
  ending = end
  input.value = ''
  count.textContent = ''
  dialog.showModal()
  update(view, true)
  input.focus()
}

export function refreshSearch(view: Sidebar) {
  if (dialog.open) update(view, false)
}

function update(view: Sidebar, fromTyping: boolean) {
  sidebar = view
  const next = searchOf(view, input.value)
  active = fromTyping ? (next[0]?.root ?? null) : activeAfter(results, next, active)
  results = next
  render()
}

function render() {
  list.replaceChildren(...results.map(option))
  const activeIndex = results.findIndex(({ root }) => root === active)
  if (activeIndex === -1) input.removeAttribute('aria-activedescendant')
  else {
    input.setAttribute('aria-activedescendant', `search-result-${activeIndex}`)
    list.children[activeIndex].scrollIntoView({ block: 'nearest' })
  }
  const message = results.length > 0 ? '' : searchOf(sidebar, '').length === 0 ? 'No Ultimate running' : 'No matching running instances'
  empty.textContent = message
  empty.hidden = message === ''
  clearTimeout(announcing)
  const spoken = message || (results.length === 1 ? '1 result' : `${results.length} results`)
  announcing = setTimeout(() => (count.textContent = spoken), ANNOUNCE_AFTER_MS)
}

function marked(text: string, spans: Span[]): Node[] {
  const parts: Node[] = []
  let at = 0
  for (const { start, end } of spans) {
    if (start > at) parts.push(document.createTextNode(text.slice(at, start)))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(start, end)
    parts.push(mark)
    at = end
  }
  if (at < text.length) parts.push(document.createTextNode(text.slice(at)))
  return parts
}

function option({ root, name, group, marks }: SearchResult, index: number): HTMLLIElement {
  const item = document.createElement('li')
  item.id = `search-result-${index}`
  item.role = 'option'
  item.ariaSelected = String(root === active)
  item.dataset.root = root
  const title = document.createElement('div')
  title.className = 'result-name'
  title.append(...marked(name, marks.name))
  const detail = document.createElement('div')
  detail.className = 'result-detail'
  detail.append(...marked(group, marks.group), ' · ', ...marked(root, marks.path))
  item.append(title, detail)
  // The field keeps the keyboard while the mouse picks a result.
  item.addEventListener('mousedown', (event) => event.preventDefault())
  item.addEventListener('click', () => void choose(root))
  return item
}

function close() {
  clearTimeout(announcing)
  // Otherwise the dialog gives focus back to the shell, also when a page opened search.
  input.blur()
  dialog.close()
  results = []
  active = null
}

async function choose(root: string | null) {
  if (root === null) return
  if (await hub.closeSearch(root)) {
    close()
    return ending?.chosen(root)
  }
  const next = results.filter((result) => result.root !== root)
  active = activeAfter(results, next, root)
  results = next
  render()
}

async function cancel() {
  close()
  await hub.closeSearch(null)
  ending?.cancelled()
}

function move(by: 1 | -1) {
  const at = results.findIndex(({ root }) => root === active)
  if (results.length === 0) return
  active = results[Math.min(results.length - 1, Math.max(0, at + by))].root
  render()
}

input.addEventListener('input', () => update(sidebar, true))
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void choose(active)
  }
})
dialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  void cancel()
})
dialog.addEventListener('click', (event) => {
  const { left, right, top, bottom } = dialog.getBoundingClientRect()
  const outside = event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
  if (outside) void cancel()
})
