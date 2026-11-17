import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type Lifecycle, type Saved, type SavedTab, type SidebarForm, type UserGroup, ZOOM_STEPS } from '../shared/tabs.ts'

function parseGroup(value: unknown): UserGroup {
  const { id, name, collapsed } = value as UserGroup
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof collapsed !== 'boolean')
    throw new Error(`bad saved group: ${JSON.stringify(value)}`)
  return { id, name, collapsed }
}

const isPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)

function parseLifecycle(value: unknown): Lifecycle | null {
  if (value === undefined || value === null) return null
  const { kind, launcher } = value as { kind?: unknown; launcher?: { node?: unknown; entry?: unknown } }
  if (kind === 'closing') return { kind }
  if (kind === 'paused' && isPath(launcher?.node) && isPath(launcher?.entry)) return { kind, launcher: { node: launcher.node, entry: launcher.entry } }
  throw new Error(`bad saved lifecycle: ${JSON.stringify(value)}`)
}

function parseTab(value: unknown, groups: ReadonlySet<string>): SavedTab {
  const { root, name, groupId, lifecycle } = value as SavedTab
  if (typeof root !== 'string' || (name !== null && typeof name !== 'string') || (groupId !== null && typeof groupId !== 'string'))
    throw new Error(`bad saved tab: ${JSON.stringify(value)}`)
  return { root, name, groupId: groupId !== null && groups.has(groupId) ? groupId : null, lifecycle: parseLifecycle(lifecycle) }
}

// A bad zoom or sidebar value must not cost the user their names and groups, so each reads as its default.
const parseZoom = (value: unknown) =>
  typeof value === 'number' && value >= ZOOM_STEPS[0] && value <= ZOOM_STEPS.at(-1)! ? value : 1

const parseSidebar = (value: unknown): SidebarForm => (value === 'rail' ? 'rail' : 'full')

/** The array that the app saved before user groups is not this shape, so it reads as corrupt. */
export function parseSaved(value: unknown): Saved {
  const { groups, tabs, zoom, sidebar } = (value ?? {}) as { groups?: unknown; tabs?: unknown; zoom?: unknown; sidebar?: unknown }
  if (!Array.isArray(groups) || !Array.isArray(tabs)) throw new Error('not { groups, tabs }')
  const parsed = groups.map(parseGroup)
  const ids = new Set<string>(parsed.map(({ id }) => id))
  return { groups: parsed, tabs: tabs.map((tab) => parseTab(tab, ids)), zoom: parseZoom(zoom), sidebar: parseSidebar(sidebar) }
}

export function loadSaved(path: string, log: (line: string) => void): Saved {
  try {
    return parseSaved(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`tabs.json: ${String(error)}`)
    return { groups: [], tabs: [], zoom: 1, sidebar: 'full' }
  }
}

export function storeSaved(path: string, saved: Saved): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(saved, null, 2))
  renameSync(`${path}.tmp`, path)
}
