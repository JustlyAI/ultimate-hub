export const SIDEBAR_WIDTH = 280
/** The hidden sidebar leaves this strip, with the window buttons and the one button that shows the sidebar again. */
export const RAIL_WIDTH = 80
/** The gap between a page and the terminal panel. The sidebar view shows through it, and it is the drag handle. */
export const PANEL_GAP = 6

// A running project, read from disk and proven. Never saved by the app.
export type Instance = {
  root: string // Absolute project path. This is the identity.
  port: number
}

declare const groupIdBrand: unique symbol
/** The renderer makes it, so that the reducer stays pure. */
export type GroupId = string & { readonly [groupIdBrand]: true }

export const UNGROUPED = 'Ungrouped'
const GROUP_NAME_MAX = 60

export type UserGroup = {
  id: GroupId
  name: string
  collapsed: boolean
}

/** How to start Ultimate again. Both paths are absolute and real. `entry` is `<clone>/bin/ultimate.ts`. */
export type Launcher = { node: string; entry: string }

/** Saved before any signal. It records a request, never permission to signal. */
export type Lifecycle = { kind: 'paused'; launcher: Launcher } | { kind: 'closing' }

// Keyed by root, never by port.
export type SavedTab = {
  root: string
  name: string | null // null means use the folder name.
  groupId: GroupId | null // null means Ungrouped.
  lifecycle: Lifecycle | null
}

/** tabs.json. One file, so that a group removal and the moves of its tabs save together. */
export type Saved = {
  groups: UserGroup[]
  tabs: SavedTab[] // Every known project, including hidden ones. The order inside each group is this order.
  zoom: number // The zoom factor of every Ultimate page. 1 is actual size.
  sidebar: SidebarForm
}

export type SidebarForm = 'full' | 'rail'

export const sidebarWidth = (form: SidebarForm) => (form === 'rail' ? RAIL_WIDTH : SIDEBAR_WIDTH)

/** Chrome's zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const
export type ZoomStep = 'in' | 'out' | 'reset'

export function zoomed(zoom: number, step: ZoomStep): number {
  if (step === 'reset') return 1
  if (step === 'in') return ZOOM_STEPS.find((factor) => factor > zoom) ?? zoom
  return ZOOM_STEPS.findLast((factor) => factor < zoom) ?? zoom
}

// One answer of Ultimate's status action. It reports per instance, not per agent.
export type InstanceStatus = {
  questions: number
  failures: number // Only those since the time the app asked about.
  busy: number
}

export type StatusKind = 'needs-you' | 'failed' | 'working' | 'done' | 'idle' | 'unknown'

export const STATUS_ORDER: readonly { kind: StatusKind; label: string }[] = [
  { kind: 'needs-you', label: 'Needs You' },
  { kind: 'failed', label: 'Failed' },
  { kind: 'working', label: 'Working' },
  { kind: 'done', label: 'Done' },
  { kind: 'idle', label: 'Idle' },
  { kind: 'unknown', label: 'Unknown' },
]

const STATUS_MAX_AGE_MS = 60000

// Ultimate has no Done state, so the app derives it.
type LastStatus = InstanceStatus & { done: boolean; answeredAt: number }

const isFresh = (status: LastStatus, now: number) => now - status.answeredAt <= STATUS_MAX_AGE_MS

declare const operationIdBrand: unique symbol
/** The main process makes it, so that a result for an old operation cannot change a newer one. */
export type OperationId = string & { readonly [operationIdBrand]: true }
export type LifecycleAction = 'pause' | 'close' | 'play'

/** In memory only. At most one for each root. `checking` comes before the confirmation and is never shown. */
export type Operation = { id: OperationId; action: LifecycleAction; phase: 'checking' | 'acting'; late: boolean }

export type TabsState = {
  saved: Saved
  instances: Instance[]
  selected: string | null
  watched: Record<string, LastStatus>
  seenAt: Record<string, number> // When the user last selected each tab, in this run of the app.
  operations: Record<string, Operation>
  errors: Record<string, string> // The last failed action of each root. The next action on that root clears it.
}

export type RowLifecycle = 'running' | 'stopping' | 'closing' | 'paused' | 'starting' | 'stopped'

export type Row = {
  root: string
  label: string
  port: number | null
  selected: boolean
  lifecycle: RowLifecycle
  status: StatusKind | null // null while the project is not running.
  error: string | null
}

export type StatusSection = { kind: StatusKind; label: string; rows: Row[] }

export type GroupView = {
  id: GroupId
  name: string
  collapsed: boolean
  count: number
  hidesSelected: boolean
  status: StatusKind | null // The most urgent status of its rows, or null when each is idle or not running.
  rows: Row[] // Also when collapsed. The renderer hides them.
}

export type Sidebar = {
  form: SidebarForm
  groups: GroupView[]
  ungrouped: Row[]
  status: StatusSection[]
}

export type MainArea =
  | { kind: 'page'; root: string; port: number }
  | { kind: 'message'; root: string; label: string; lifecycle: Exclude<RowLifecycle, 'running'>; error: string | null }
  | { kind: 'empty' }

export type Command =
  | { type: 'scan'; instances: Instance[]; fresh: boolean } // fresh is false when lsof failed.
  | { type: 'select'; root: string }
  | { type: 'add'; root: string; launcher: Launcher | null } // From + > Ultimate. The launcher lets a stopped project start.
  | { type: 'rename'; root: string; name: string }
  | { type: 'move'; root: string; target: string; place: 'before' | 'after' }
  | { type: 'remove'; root: string }
  | { type: 'cycle'; by: 1 | -1 }
  | { type: 'status'; root: string; port: number; since: number | undefined; status: InstanceStatus }
  | { type: 'create-group'; id: GroupId; name: string }
  | { type: 'rename-group'; id: GroupId; name: string }
  | { type: 'remove-group'; id: GroupId }
  | { type: 'move-group'; id: GroupId; target: GroupId; place: 'before' | 'after' }
  | { type: 'collapse-group'; id: GroupId; collapsed: boolean }
  | { type: 'move-to-group'; root: string; groupId: GroupId | null }
  | { type: 'zoom'; step: ZoomStep }
  | { type: 'toggle-sidebar' }
  | { type: 'lifecycle'; root: string; id: OperationId; action: LifecycleAction }
  | { type: 'lifecycle-confirmed'; root: string; id: OperationId; launcher: Launcher | null }
  | { type: 'lifecycle-stopped'; root: string; id: OperationId; replaced: boolean }
  | { type: 'lifecycle-started'; root: string; id: OperationId }
  | { type: 'lifecycle-failed'; root: string; id: OperationId; error: string | null; before: boolean } // before: no signal was sent.
  | { type: 'lifecycle-late'; root: string; id: OperationId; error: string }

type LifecycleResult = Extract<Command, { type: `lifecycle-${string}` }>

export const INSTANCE_CHANGED = 'Another Ultimate started for this project, so Hub did not close it.'

export type NameRefusal = 'empty' | 'too-long' | 'taken'

export function groupNameRefusal(groups: readonly UserGroup[], name: string, renaming?: GroupId): NameRefusal | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'empty'
  if ([...trimmed].length > GROUP_NAME_MAX) return 'too-long'
  const lower = trimmed.toLowerCase()
  if (lower === UNGROUPED.toLowerCase() || groups.some((group) => group.id !== renaming && group.name.toLowerCase() === lower)) return 'taken'
  return null
}

export const initialState = (saved: Saved): TabsState => ({
  saved,
  instances: [],
  selected: null,
  watched: {},
  seenAt: {},
  operations: {},
  errors: {},
})

export function portOf(state: TabsState, root: string): number | null {
  return state.instances.find((instance) => instance.root === root)?.port ?? null
}

export const folderName = (root: string) => root.split('/').pop() ?? root

const labelOf = (tab: SavedTab) => tab.name ?? folderName(tab.root)

const ACTING: Record<LifecycleAction, RowLifecycle> = { pause: 'stopping', close: 'closing', play: 'starting' }

export function rowLifecycle(running: boolean, record: Lifecycle | null, operation: Operation | undefined): RowLifecycle {
  // A start asks nothing, so it shows from the click. A stop shows only after its question.
  if (operation?.phase === 'acting' || operation?.action === 'play') return ACTING[operation.action]
  if (running) return 'running'
  return record?.kind === 'paused' ? 'paused' : 'stopped'
}

const lifecycleOf = (state: TabsState, tab: SavedTab) =>
  rowLifecycle(portOf(state, tab.root) !== null, tab.lifecycle, state.operations[tab.root])

function statusOf(watched: LastStatus | undefined): StatusKind {
  if (!watched) return 'unknown'
  if (watched.questions > 0) return 'needs-you'
  if (watched.failures > 0) return 'failed'
  if (watched.busy > 0) return 'working'
  return watched.done ? 'done' : 'idle'
}

const isShown = (state: TabsState, tab: SavedTab) =>
  tab.groupId !== null ||
  tab.name !== null ||
  tab.lifecycle !== null ||
  tab.root in state.operations ||
  tab.root === state.selected ||
  portOf(state, tab.root) !== null

export function sidebarOf(state: TabsState): Sidebar {
  const rowsIn = (groupId: GroupId | null) =>
    state.saved.tabs
      .filter((tab) => tab.groupId === groupId && isShown(state, tab))
      .map((tab) => {
        const lifecycle = lifecycleOf(state, tab)
        return {
          root: tab.root,
          label: labelOf(tab),
          port: portOf(state, tab.root),
          selected: tab.root === state.selected,
          lifecycle,
          status: lifecycle === 'running' ? statusOf(state.watched[tab.root]) : null,
          error: state.errors[tab.root] ?? null,
        }
      })
  const groups = state.saved.groups.map(({ id, name, collapsed }) => {
    const rows = rowsIn(id)
    const urgent = STATUS_ORDER.find(({ kind }) => kind !== 'idle' && rows.some((row) => row.status === kind))
    return { id, name, collapsed, count: rows.length, hidesSelected: collapsed && rows.some((row) => row.selected), status: urgent?.kind ?? null, rows }
  })
  const ungrouped = rowsIn(null)
  const rows = [...groups.flatMap((group) => group.rows), ...ungrouped]
  const status = STATUS_ORDER.map(({ kind, label }) => ({
    kind,
    label,
    rows: rows.filter((row) => row.status === kind),
  })).filter((section) => section.rows.length > 0)
  return { form: state.saved.sidebar, groups, ungrouped, status }
}

const visibleRows = ({ groups, ungrouped }: Sidebar) => [...groups.flatMap((group) => (group.collapsed ? [] : group.rows)), ...ungrouped]

export function mainOf(state: TabsState): MainArea {
  const tab = state.saved.tabs.find(({ root }) => root === state.selected)
  if (!tab) return { kind: 'empty' }
  const port = portOf(state, tab.root)
  const lifecycle = lifecycleOf(state, tab)
  if (lifecycle === 'running' && port !== null) return { kind: 'page', root: tab.root, port }
  return { kind: 'message', root: tab.root, label: labelOf(tab), lifecycle: lifecycle === 'running' ? 'stopped' : lifecycle, error: state.errors[tab.root] ?? null }
}

export function selectedRoot(state: TabsState): string | null {
  return state.saved.tabs.some(({ root }) => root === state.selected) ? state.selected : null
}

export function reduce(state: TabsState, command: Command, now: number): TabsState {
  const next = withDefaultSelection(transition(state, command, now))
  const seen = next.selected !== null && (command.type === 'select' || next.selected !== state.selected)
  return seen ? markSeen(next, next.selected!, now) : next
}

/** The user has seen this tab, so what it reported until now no longer needs them. */
function markSeen(state: TabsState, root: string, now: number): TabsState {
  const watched = state.watched[root]
  return {
    ...state,
    seenAt: { ...state.seenAt, [root]: now },
    watched: watched ? { ...state.watched, [root]: { ...watched, failures: 0, done: false } } : state.watched,
  }
}

function withStatus(state: TabsState, { root, port, since, status }: Extract<Command, { type: 'status' }>, now: number): TabsState {
  // A slow answer can come from a port that the project has left.
  if (portOf(state, root) !== port) return state
  const before = state.watched[root]
  // An answer that was asked before the user last selected the tab counts failures that the user has seen.
  const failures = (since ?? 0) < (state.seenAt[root] ?? 0) ? (before?.failures ?? 0) : status.failures
  const finished = before !== undefined && before.busy > 0 && status.busy === 0 && root !== state.selected
  return { ...state, watched: { ...state.watched, [root]: { ...status, failures, done: finished || before?.done === true, answeredAt: now } } }
}

function transition(state: TabsState, command: Command, now: number): TabsState {
  const { groups, tabs } = state.saved
  const withTabs = (next: SavedTab[]) => ({ ...state, saved: { ...state.saved, tabs: next } })
  const withGroups = (next: UserGroup[]) => ({ ...state, saved: { ...state.saved, groups: next } })
  const groupExists = (id: GroupId) => groups.some((group) => group.id === id)
  switch (command.type) {
    case 'scan': {
      const added = command.instances
        .filter(({ root }) => !tabs.some((tab) => tab.root === root))
        .map(({ root }) => ({ root, name: null, groupId: null, lifecycle: null }))
      // A status belongs to one process. A stopped tab has none, and a new port is a new process.
      const watched = Object.fromEntries(
        command.instances.flatMap(({ root, port }) => {
          const kept = state.watched[root]
          return portOf(state, root) === port && kept && isFresh(kept, now) ? [[root, kept]] : []
        }),
      )
      const kept = command.fresh ? recovered(state, new Set(command.instances.map(({ root }) => root))) : tabs
      return { ...withTabs([...kept, ...added]), instances: command.instances, watched }
    }
    case 'select':
      // A native menu can answer after its tab has left the list.
      return tabs.some((tab) => tab.root === command.root) ? selected(state, command.root) : state
    case 'add': {
      const { root, launcher } = command
      const tab = tabs.find((candidate) => candidate.root === root)
      // A stopped project gets the record that Play starts from. A running or busy one keeps what it has.
      const startable = launcher !== null && tab?.lifecycle == null && portOf(state, root) === null && !(root in state.operations)
      const lifecycle: Lifecycle | null = startable ? { kind: 'paused', launcher } : (tab?.lifecycle ?? null)
      const next = tab
        ? tabs.map((candidate) => (candidate.root === root ? { ...candidate, lifecycle } : candidate))
        : [...tabs, { root, name: null, groupId: null, lifecycle }]
      return selected(withTabs(next), root)
    }
    case 'rename': {
      const name = command.name.trim() || null
      return withTabs(tabs.map((tab) => (tab.root === command.root ? { ...tab, name } : tab)))
    }
    case 'move': {
      const moved = tabs.find(({ root }) => root === command.root)
      if (!moved || command.root === command.target) return state
      const rest = tabs.filter(({ root }) => root !== command.root)
      const at = rest.findIndex(({ root }) => root === command.target)
      if (at === -1) return state
      return withTabs(rest.toSpliced(command.place === 'before' ? at : at + 1, 0, { ...moved, groupId: rest[at].groupId }))
    }
    case 'move-to-group': {
      const { root, groupId } = command
      const at = tabs.findIndex((tab) => tab.root === root)
      if (at === -1 || (groupId !== null && !groupExists(groupId))) return state
      // The end of the array is the end of every group.
      if (tabs[at].groupId === groupId && !tabs.slice(at + 1).some((tab) => tab.groupId === groupId)) return state
      return withTabs([...tabs.toSpliced(at, 1), { ...tabs[at], groupId }])
    }
    case 'remove':
      if (portOf(state, command.root) !== null || command.root in state.operations) return state
      return {
        ...withTabs(tabs.filter(({ root }) => root !== command.root)),
        selected: state.selected === command.root ? null : state.selected,
      }
    case 'create-group':
      if (groupExists(command.id) || groupNameRefusal(groups, command.name) !== null) return state
      return withGroups([...groups, { id: command.id, name: command.name.trim(), collapsed: false }])
    case 'rename-group':
      if (!groupExists(command.id) || groupNameRefusal(groups, command.name, command.id) !== null) return state
      return withGroups(groups.map((group) => (group.id === command.id ? { ...group, name: command.name.trim() } : group)))
    case 'move-group': {
      const moved = groups.find((group) => group.id === command.id)
      const rest = groups.filter((group) => group.id !== command.id)
      const at = rest.findIndex((group) => group.id === command.target)
      if (!moved || at === -1) return state
      return withGroups(rest.toSpliced(command.place === 'before' ? at : at + 1, 0, moved))
    }
    case 'collapse-group':
      return withGroups(groups.map((group) => (group.id === command.id ? { ...group, collapsed: command.collapsed } : group)))
    case 'remove-group': {
      if (!groupExists(command.id)) return state
      const leaving = tabs.filter((tab) => tab.groupId === command.id).map((tab) => ({ ...tab, groupId: null }))
      return {
        ...state,
        saved: {
          ...state.saved,
          groups: groups.filter((group) => group.id !== command.id),
          tabs: [...tabs.filter((tab) => tab.groupId !== command.id), ...leaving],
        },
      }
    }
    case 'cycle': {
      const rows = visibleRows(sidebarOf(state))
      if (rows.length === 0) return state
      const at = rows.findIndex(({ selected }) => selected)
      // A selected tab in a collapsed group has no place among the visible rows.
      const next = at === -1 ? (command.by === 1 ? 0 : rows.length - 1) : (at + command.by + rows.length) % rows.length
      return { ...state, selected: rows[next].root }
    }
    case 'status':
      return withStatus(state, command, now)
    case 'zoom':
      return { ...state, saved: { ...state.saved, zoom: zoomed(state.saved.zoom, command.step) } }
    case 'toggle-sidebar':
      return { ...state, saved: { ...state.saved, sidebar: state.saved.sidebar === 'rail' ? 'full' : 'rail' } }
    case 'lifecycle':
      return withOperation(state, command)
    default:
      return withResult(state, command)
  }
}

/** Selecting a tab reveals its top row. Scans and the first selection do not select, so they never expand a group. */
function selected(state: TabsState, root: string): TabsState {
  const groupId = state.saved.tabs.find((tab) => tab.root === root)?.groupId
  const groups = state.saved.groups.map((group) => (group.id === groupId && group.collapsed ? { ...group, collapsed: false } : group))
  return { ...state, saved: { ...state.saved, groups }, selected: root }
}

/**
 * Saved records are evidence, not instructions, and a running instance wins. A tab with an operation is left to that
 * operation, so this never races it.
 */
function recovered(state: TabsState, running: ReadonlySet<string>): SavedTab[] {
  return state.saved.tabs.flatMap((tab) => {
    if (tab.lifecycle === null || tab.root in state.operations) return [tab]
    if (running.has(tab.root)) return [{ ...tab, lifecycle: null }]
    return tab.lifecycle.kind === 'closing' ? [] : [tab]
  })
}

function withOperation(state: TabsState, { root, id, action }: Extract<Command, { type: 'lifecycle' }>): TabsState {
  const tab = state.saved.tabs.find((candidate) => candidate.root === root)
  if (!tab || root in state.operations) return state
  const now = lifecycleOf(state, tab)
  if (action === 'play' ? now !== 'paused' : now !== 'running') return state
  const { [root]: _cleared, ...errors } = state.errors
  return { ...state, operations: { ...state.operations, [root]: { id, action, phase: 'checking', late: false } }, errors }
}

function withResult(state: TabsState, command: LifecycleResult): TabsState {
  const { root } = command
  const operation = state.operations[root]
  if (operation?.id !== command.id) return state
  const { [root]: _ended, ...operations } = state.operations
  const ended = { ...state, operations }
  const withRecord = (next: TabsState, lifecycle: Lifecycle | null): TabsState => ({
    ...next,
    saved: { ...next.saved, tabs: next.saved.tabs.map((tab) => (tab.root === root ? { ...tab, lifecycle } : tab)) },
  })
  const withError = (next: TabsState, error: string | null): TabsState =>
    error === null ? next : { ...next, errors: { ...next.errors, [root]: error } }
  switch (command.type) {
    case 'lifecycle-confirmed': {
      if (operation.phase !== 'checking') return state
      const acting = { ...state, operations: { ...state.operations, [root]: { ...operation, phase: 'acting' as const } } }
      if (operation.action === 'play') return acting
      if (operation.action === 'close') return withRecord(acting, { kind: 'closing' })
      return command.launcher ? withRecord(acting, { kind: 'paused', launcher: command.launcher }) : state
    }
    case 'lifecycle-late':
      return withError({ ...state, operations: { ...state.operations, [root]: { ...operation, late: true } } }, command.error)
    case 'lifecycle-started':
      return withRecord(ended, null)
    case 'lifecycle-failed': {
      // With no signal sent, the record that the confirmation saved must not pause or close the row. A failed start keeps it.
      const unsent = command.before && operation.action !== 'play' && operation.phase === 'acting'
      return withError(unsent ? withRecord(ended, null) : ended, command.error)
    }
    case 'lifecycle-stopped': {
      if (command.replaced) return withError(withRecord(ended, null), operation.action === 'close' ? INSTANCE_CHANGED : null)
      if (operation.action !== 'close') return ended
      return {
        ...ended,
        saved: { ...state.saved, tabs: state.saved.tabs.filter((tab) => tab.root !== root) },
        selected: state.selected === root ? neighbourOf(state, root) : state.selected,
      }
    }
  }
}

/** The next visible row, then the previous one. */
function neighbourOf(state: TabsState, root: string): string | null {
  const rows = visibleRows(sidebarOf(state))
  const at = rows.findIndex((row) => row.root === root)
  if (at === -1) return null
  return (rows[at + 1] ?? rows[at - 1])?.root ?? null
}

export type SearchField = 'name' | 'group' | 'path'

/** A matched part of a field's text, from `start` up to but not including `end`. */
export type Span = { start: number; end: number }

export type SearchResult = {
  root: string // Also the text of the path field.
  name: string
  group: string // The user group name, or UNGROUPED.
  marks: Record<SearchField, Span[]>
}

function spansOf(text: string, terms: readonly string[]): Span[] {
  const lower = text.toLowerCase()
  const found: Span[] = []
  for (const term of terms)
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) found.push({ start: at, end: at + term.length })
  const merged: Span[] = []
  for (const span of found.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/** The live tabs that match every term of the query, in rank order, then in sidebar order. Collapse changes nothing. */
export function searchOf({ groups, ungrouped }: Sidebar, query: string): SearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const phrase = terms.join(' ')
  const live = [...groups.flatMap(({ name, rows }) => rows.map((row) => ({ row, group: name }))), ...ungrouped.map((row) => ({ row, group: UNGROUPED }))]
  const ranked = live.flatMap(({ row, group }) => {
    if (row.lifecycle !== 'running') return []
    const texts = [row.label, group, row.root].map((text) => text.toLowerCase())
    if (!terms.every((term) => texts.some((text) => text.includes(term)))) return []
    const name = texts[0]
    const rank = phrase !== '' && name === phrase ? 0 : phrase !== '' && name.startsWith(phrase) ? 1 : 2
    const marks = { name: spansOf(row.label, terms), group: spansOf(group, terms), path: spansOf(row.root, terms) }
    return [{ rank, result: { root: row.root, name: row.label, group, marks } }]
  })
  return ranked.toSorted((a, b) => a.rank - b.rank).map(({ result }) => result)
}

/** The active result after the results change: the same root, else the result now at its old place, else the last. */
export function activeAfter(before: readonly SearchResult[], after: readonly SearchResult[], active: string | null): string | null {
  if (after.length === 0) return null
  if (after.some(({ root }) => root === active)) return active
  const at = Math.max(0, before.findIndex(({ root }) => root === active))
  return after[Math.min(at, after.length - 1)].root
}

function withDefaultSelection(state: TabsState): TabsState {
  if (state.selected !== null) return state
  const sidebar = sidebarOf(state)
  const isLive = (row: Row) => row.port !== null
  const visibleLive = visibleRows(sidebar).find(isLive)
  const collapsedLive = sidebar.groups.flatMap(({ rows }) => rows).find(isLive)
  const live = visibleLive ?? collapsedLive
  return live ? { ...state, selected: live.root } : state
}
