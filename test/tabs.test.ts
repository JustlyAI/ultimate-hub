import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSaved } from '../src/main/saved.ts'
import { parseListeners, parseStatus } from '../src/main/ultimate.ts'
import {
  activeAfter,
  groupNameRefusal,
  INSTANCE_CHANGED,
  initialState,
  mainOf,
  reduce,
  searchOf,
  selectedRoot,
  sidebarOf,
  type SearchResult,
  type Command,
  type GroupId,
  type Instance,
  type InstanceStatus,
  type LifecycleAction,
  type OperationId,
  type MainArea,
  type Saved,
  type SavedTab,
  type TabsState,
  RAIL_WIDTH,
  SIDEBAR_WIDTH,
  sidebarWidth,
  ZOOM_STEPS,
  zoomed,
} from '../src/shared/tabs.ts'

const [A, B, C, D] = ['/p/alpha', '/p/beta', '/p/gamma', '/p/delta']
const NOW = 1000

const live = (root: string, port: number): Instance => ({ root, port })
const saved = (root: string, name: string | null = null, groupId: GroupId | null = null): SavedTab => ({ root, name, groupId, lifecycle: null })
const savedOf = (...tabs: SavedTab[]): Saved => ({ groups: [], tabs, zoom: 1, sidebar: 'full' })
const scan = (...instances: Instance[]): Command => ({ type: 'scan', instances, fresh: true })
const notRunning = (root: string, label: string): MainArea => ({ kind: 'message', root, label, lifecycle: 'stopped', error: null })
const run = (state: TabsState, ...commands: Command[]) => commands.reduce((next, command) => reduce(next, command, NOW), state)
const start = (...commands: Command[]) => run(initialState(savedOf()), ...commands)
const labels = (state: TabsState) => sidebarOf(state).ungrouped.map((row) => row.label)
const selectedLabel = (state: TabsState) => {
  const { groups, ungrouped } = sidebarOf(state)
  return [...groups.flatMap(({ rows }) => rows), ...ungrouped].find((row) => row.selected)?.label
}
const statusList = (state: TabsState) => sidebarOf(state).status.map(({ label, rows }) => [label, rows.map((row) => row.label)])

test('running projects appear with the folder name and the first one is selected', () => {
  const state = start(scan(live(A, 4747), live(B, 4748)))
  const rows = [
    { root: A, label: 'alpha', port: 4747, selected: true, lifecycle: 'running', status: 'unknown', error: null },
    { root: B, label: 'beta', port: 4748, selected: false, lifecycle: 'running', status: 'unknown', error: null },
  ]
  assert.deepEqual(sidebarOf(state), { form: 'full', groups: [], ungrouped: rows, status: [{ kind: 'unknown', label: 'Unknown', rows }] })
  assert.deepEqual(mainOf(state), { kind: 'page', root: A, port: 4747 })
})

test('a project joins the order when it first runs', () => {
  const state = start(scan(live(B, 4748)), scan(live(A, 4749), live(B, 4748)))
  assert.deepEqual(labels(state), ['beta', 'alpha'])
})

test('no tabs and no selection shows that no Ultimate is running', () => {
  assert.deepEqual(mainOf(start(scan())), { kind: 'empty' })
})

test('named tabs dim when the project stops, and do not lose their name', () => {
  const state = start(
    scan(live(A, 4747), live(B, 4748)),
    { type: 'rename', root: B, name: 'Website' },
    scan(live(A, 4747)),
  )
  assert.deepEqual(sidebarOf(state).ungrouped, [
    { root: A, label: 'alpha', port: 4747, selected: true, lifecycle: 'running', status: 'unknown', error: null },
    { root: B, label: 'Website', port: null, selected: false, lifecycle: 'stopped', status: null, error: null },
  ])
  assert.deepEqual(statusList(state), [['Unknown', ['alpha']]], 'a dimmed tab has no status row')
})

test('an unnamed tab that is not selected leaves the list when its project stops', () => {
  const state = start(scan(live(A, 4747), live(B, 4748)), scan(live(A, 4747)))
  assert.deepEqual(labels(state), ['alpha'])
})

test('an unnamed selected tab stays dimmed until another tab is selected', () => {
  const dimmed = start(scan(live(A, 4747), live(B, 4748)), scan(live(B, 4748)))
  assert.deepEqual(sidebarOf(dimmed).ungrouped[0], { root: A, label: 'alpha', port: null, selected: true, lifecycle: 'stopped', status: null, error: null })
  assert.deepEqual(statusList(dimmed), [['Unknown', ['beta']]], 'a dimmed selected tab has no status row')
  assert.deepEqual(mainOf(dimmed), notRunning(A, 'alpha'))
  assert.deepEqual(labels(run(dimmed, { type: 'select', root: B })), ['beta'])
})

test('selecting a dimmed named tab shows that it is not running', () => {
  const state = start(
    scan(live(A, 4747), live(B, 4748)),
    { type: 'rename', root: B, name: 'Website' },
    scan(live(A, 4747)),
    { type: 'select', root: B },
  )
  assert.deepEqual(mainOf(state), notRunning(B, 'Website'))
})

test('the selected folder follows the selection, for a live tab and a dimmed tab', () => {
  const running = start(scan(live(A, 1), live(B, 2)), { type: 'rename', root: B, name: 'Website' })
  assert.equal(selectedRoot(running), A)
  const onB = run(running, { type: 'select', root: B })
  assert.equal(selectedRoot(onB), B)
  assert.equal(selectedRoot(run(onB, scan(live(A, 1)))), B)
})

test('no selected tab means no folder', () => {
  assert.equal(selectedRoot(initialState(savedOf())), null)
  assert.equal(selectedRoot(initialState(savedOf(saved(A, 'Website')))), null)
  const removed = run(initialState(savedOf(saved(A, 'Website'))), { type: 'select', root: A }, { type: 'remove', root: A })
  assert.equal(selectedRoot(removed), null)
  assert.equal(selectedRoot({ ...initialState(savedOf()), selected: A }), null)
})

test('a project that returns on a new port keeps its name and position', () => {
  const state = start(
    scan(live(A, 4747), live(B, 4748)),
    { type: 'rename', root: A, name: 'Website' },
    scan(live(B, 4748)),
    scan(live(A, 5000), live(B, 4748)),
  )
  assert.deepEqual(sidebarOf(state).ungrouped[0], { root: A, label: 'Website', port: 5000, selected: true, lifecycle: 'running', status: 'unknown', error: null })
  assert.equal(kindOf(state, A), 'unknown')
  assert.deepEqual(mainOf(state), { kind: 'page', root: A, port: 5000 })
})

test('a hidden project goes back to its place, and a new project goes to the end', () => {
  const state = start(
    scan(live(A, 1), live(B, 2), live(C, 3)),
    scan(live(A, 1), live(C, 3)),
    scan(live(A, 1), live(C, 3), live(D, 4)),
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
  )
  assert.deepEqual(labels(state), ['alpha', 'beta', 'gamma', 'delta'])
})

test('dragging moves a tab before its target and to the end, around hidden projects', () => {
  const running = scan(live(A, 1), live(B, 2), live(C, 3))
  const toFront = start(running, { type: 'move', root: C, target: A, place: 'before' })
  assert.deepEqual(labels(toFront), ['gamma', 'alpha', 'beta'])
  const toEnd = start(running, { type: 'move', root: A, target: C, place: 'after' })
  assert.deepEqual(labels(toEnd), ['beta', 'gamma', 'alpha'])
  const aroundHidden = start(
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
    scan(live(A, 1), live(C, 3), live(D, 4)),
    { type: 'move', root: D, target: C, place: 'before' },
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
  )
  assert.deepEqual(labels(aroundHidden), ['alpha', 'beta', 'delta', 'gamma'])
})

test('dragging does not keep a stopped tab in the list', () => {
  const state = start(
    scan(live(A, 1), live(B, 2), live(C, 3)),
    { type: 'move', root: C, target: A, place: 'before' },
    scan(live(A, 1), live(B, 2)),
  )
  assert.deepEqual(labels(state), ['alpha', 'beta'])
})

test('order and names survive a save and reload, and array order is the saved order', () => {
  const before = start(
    scan(live(A, 1), live(B, 2), live(C, 3)),
    { type: 'rename', root: B, name: 'Website' },
    { type: 'move', root: C, target: A, place: 'before' },
    scan(live(A, 1), live(B, 2)),
  )
  assert.deepEqual(before.saved.tabs, [saved(C), saved(A), saved(B, 'Website')])
  const after = run(initialState(parseSaved(JSON.parse(JSON.stringify(before.saved)))), scan(live(A, 7), live(B, 8), live(C, 9)))
  assert.deepEqual(labels(after), ['gamma', 'alpha', 'Website'])
})

test('renaming to blank goes back to the folder name', () => {
  const state = start(scan(live(A, 1)), { type: 'rename', root: A, name: 'x' }, { type: 'rename', root: A, name: '  ' })
  assert.deepEqual(labels(state), ['alpha'])
  assert.equal(state.saved.tabs[0].name, null)
})

test('removing a dimmed tab forgets it, so it comes back as new with its folder name', () => {
  const state = start(
    scan(live(A, 1), live(B, 2)),
    { type: 'rename', root: A, name: 'Website' },
    scan(live(B, 2)),
    { type: 'remove', root: A },
  )
  assert.deepEqual(state.saved.tabs, [saved(B)])
  assert.deepEqual(labels(run(state, scan(live(A, 3), live(B, 2)))), ['beta', 'alpha'])
})

test('a live tab cannot be removed', () => {
  const state = start(scan(live(A, 1)), { type: 'remove', root: A })
  assert.deepEqual(labels(state), ['alpha'])
})

test('removing the selected tab selects the first live tab, or shows no Ultimate running', () => {
  const withLive = start(
    scan(live(A, 1), live(B, 2)),
    { type: 'rename', root: A, name: 'Website' },
    scan(live(B, 2)),
    { type: 'remove', root: A },
  )
  assert.equal(selectedLabel(withLive), 'beta')
  const withoutLive = start(scan(live(A, 1)), scan(), { type: 'remove', root: A })
  assert.deepEqual(mainOf(withoutLive), { kind: 'empty' })
})

test('a named stopped tab alone is not selected at launch, and the main area shows no Ultimate running', () => {
  const state = run(initialState(savedOf(saved(A, 'Website'))), scan())
  assert.deepEqual(labels(state), ['Website'])
  assert.deepEqual(mainOf(state), { kind: 'empty' })
})

test('at launch the first live tab is selected, past any stopped tab', () => {
  const state = run(initialState(savedOf(saved(A, 'Website'), saved(B))), scan(live(B, 2)))
  assert.equal(selectedLabel(state), 'beta')
})

test('cycling moves through visible tabs in both directions and wraps', () => {
  const state = start(scan(live(A, 1), live(B, 2), live(C, 3)))
  assert.equal(selectedLabel(run(state, { type: 'cycle', by: 1 })), 'beta')
  assert.equal(selectedLabel(run(state, { type: 'cycle', by: -1 })), 'gamma')
  assert.equal(selectedLabel(run(state, { type: 'cycle', by: 1 }, { type: 'cycle', by: 1 }, { type: 'cycle', by: 1 })), 'alpha')
})

test('cycling skips hidden projects and reaches dimmed tabs', () => {
  const state = start(
    scan(live(A, 1), live(B, 2), live(C, 3)),
    { type: 'rename', root: C, name: 'Website' },
    scan(live(A, 1)),
  )
  assert.deepEqual(labels(state), ['alpha', 'Website'])
  assert.deepEqual(mainOf(run(state, { type: 'cycle', by: 1 })), notRunning(C, 'Website'))
})

test('cycling with no tabs does nothing', () => {
  assert.deepEqual(mainOf(start(scan(), { type: 'cycle', by: 1 })), { kind: 'empty' })
})

test('a port that passes between projects follows each root, never the port', () => {
  const state = start(
    scan(live(A, 4747), live(B, 4748)),
    { type: 'rename', root: A, name: 'Website' },
    scan(live(B, 4747)),
  )
  assert.deepEqual(sidebarOf(state).ungrouped, [
    { root: A, label: 'Website', port: null, selected: true, lifecycle: 'stopped', status: null, error: null },
    { root: B, label: 'beta', port: 4747, selected: false, lifecycle: 'running', status: 'unknown', error: null },
  ])
  assert.deepEqual(statusList(state), [['Unknown', ['beta']]])
  assert.deepEqual(mainOf(state), notRunning(A, 'Website'))
})

test('lsof output gives the ports of each process', () => {
  const output = 'p101\nf9\nn127.0.0.1:4747\nf10\nn*:5000\np202\nf7\nn[::1]:4748\n'
  assert.deepEqual(parseListeners(output), new Map([[101, new Set([4747, 5000])], [202, new Set([4748])]]))
  assert.deepEqual(parseListeners(''), new Map())
})

const status = (root: string, port: number, fields: Partial<InstanceStatus>, since?: number): Command => ({
  type: 'status',
  root,
  port,
  since,
  status: { questions: 0, failures: 0, busy: 0, ...fields },
})
const select = (root: string, at: number) => (state: TabsState) => reduce(state, { type: 'select', root }, at)
const kindOf = (state: TabsState, root: string) => sidebarOf(state).status.find(({ rows }) => rows.some((row) => row.root === root))?.kind

test('each status goes to its section, and the first match wins', () => {
  const state = start(
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
    status(B, 2, { questions: 1, failures: 2, busy: 3 }),
    status(C, 3, { failures: 2, busy: 3 }),
    status(D, 4, { busy: 3 }),
  )
  assert.equal(kindOf(state, B), 'needs-you')
  assert.equal(kindOf(state, C), 'failed')
  assert.equal(kindOf(state, D), 'working')
  assert.equal(kindOf(state, A), 'unknown')
})

test('the Status list follows the status order, and its rows follow the top list', () => {
  const state = start(
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
    status(D, 4, { questions: 1 }),
    status(C, 3, { busy: 1 }),
    status(B, 2, { questions: 1 }),
  )
  assert.deepEqual(statusList(state), [['Needs You', ['beta', 'delta']], ['Working', ['gamma']], ['Unknown', ['alpha']]])
  const moved = run(state, { type: 'move', root: D, target: A, place: 'before' })
  assert.deepEqual(labels(moved), ['delta', 'alpha', 'beta', 'gamma'])
  assert.deepEqual(statusList(moved), [['Needs You', ['delta', 'beta']], ['Working', ['gamma']], ['Unknown', ['alpha']]])
})

test('a status change never moves a top row', () => {
  const steps = [status(D, 4, { questions: 1 }), status(C, 3, { busy: 1 }), status(B, 2, { failures: 1 }), status(C, 3, {}), status(A, 1, { busy: 1 })]
  let state = start(scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)))
  const kinds = new Set<string>()
  for (const step of steps) {
    state = run(state, step)
    assert.deepEqual(labels(state), ['alpha', 'beta', 'gamma', 'delta'])
    for (const { kind } of sidebarOf(state).status) kinds.add(kind)
  }
  assert.deepEqual([...kinds].toSorted(), ['done', 'failed', 'needs-you', 'unknown', 'working'], 'the statuses did change')
})

test('an empty status has no section, and each section counts its rows', () => {
  const state = start(scan(live(A, 1), live(B, 2), live(C, 3)), status(B, 2, { busy: 1 }), status(C, 3, { busy: 1 }))
  assert.deepEqual(
    sidebarOf(state).status.map(({ label, rows }) => [label, rows.length]),
    [['Working', 2], ['Unknown', 1]],
  )
  assert.deepEqual(sidebarOf(initialState(savedOf())), { form: 'full', groups: [], ungrouped: [], status: [] })
})

test('a move across statuses reorders the top list', () => {
  const state = start(scan(live(A, 1), live(B, 2), live(C, 3)), status(A, 1, { questions: 1 }), status(C, 3, { busy: 1 }))
  const moved = run(state, { type: 'move', root: C, target: A, place: 'before' })
  assert.deepEqual(labels(moved), ['gamma', 'alpha', 'beta'])
  assert.deepEqual(moved.saved.tabs.map(({ root }) => root), [C, A, B])
  assert.equal(kindOf(moved, C), 'working', 'a move keeps the status')
})

test('busy going to zero while the tab is not selected is Done, and selecting the tab clears it', () => {
  const state = start(scan(live(A, 1), live(B, 2)), status(B, 2, { busy: 1 }), status(B, 2, { busy: 0 }))
  assert.equal(kindOf(state, B), 'done')
  assert.equal(kindOf(run(state, status(B, 2, {})), B), 'done', 'Done stays on later answers')
  assert.equal(kindOf(run(state, { type: 'select', root: B }), B), 'idle')
})

test('busy going to zero on the selected tab is not Done', () => {
  const state = start(scan(live(A, 1)), status(A, 1, { busy: 1 }), status(A, 1, { busy: 0 }))
  assert.equal(kindOf(state, A), 'idle')
})

test('a tab that was never seen busy is not Done, and a new run replaces Done with Working', () => {
  const first = start(scan(live(A, 1), live(B, 2)), status(B, 2, {}))
  assert.equal(kindOf(first, B), 'idle')
  const again = run(first, status(B, 2, { busy: 1 }), status(B, 2, {}), status(B, 2, { busy: 1 }))
  assert.equal(kindOf(again, B), 'working')
  assert.equal(kindOf(run(again, status(B, 2, {})), B), 'done')
})

test('Ctrl+Tab follows the top list and never the Status list', () => {
  const mixed = start(
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
    status(C, 3, { questions: 1 }),
    status(A, 1, { busy: 1 }),
    status(B, 2, {}),
  )
  assert.deepEqual(statusList(mixed), [['Needs You', ['gamma']], ['Working', ['alpha']], ['Idle', ['beta']], ['Unknown', ['delta']]])
  const fromGamma = run(mixed, { type: 'select', root: C }, { type: 'cycle', by: 1 })
  assert.equal(selectedLabel(fromGamma), 'delta', 'the next top row, not the next status row')
  assert.equal(selectedLabel(run(fromGamma, { type: 'cycle', by: 1 })), 'alpha', 'the wrap goes to the first top row')
  assert.equal(selectedLabel(run(mixed, { type: 'select', root: C }, { type: 'cycle', by: -1 })), 'beta')
})

test('Ctrl+Tab visits each top row once in order, and selecting clears Done', () => {
  let state = start(
    scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4)),
    status(B, 2, { busy: 1 }),
    status(C, 3, { busy: 1 }),
    status(B, 2, {}),
    status(C, 3, {}),
    status(A, 1, {}),
    status(D, 4, {}),
  )
  assert.deepEqual(statusList(state), [['Done', ['beta', 'gamma']], ['Idle', ['alpha', 'delta']]])
  const visited: string[] = []
  for (let step = 0; step < 4; step++) {
    state = run(state, { type: 'cycle', by: 1 })
    visited.push(selectedLabel(state)!)
  }
  assert.deepEqual(visited, ['beta', 'gamma', 'delta', 'alpha'])
  assert.deepEqual(statusList(state), [['Idle', ['alpha', 'beta', 'gamma', 'delta']]], 'every visited tab was cleared')
})

test('selecting a tab clears its failures, and failures after that time return', () => {
  const failed = run(start(scan(live(A, 1), live(B, 2))), status(B, 2, { failures: 2 }))
  assert.equal(kindOf(failed, B), 'failed')
  const seen = select(B, 500)(failed)
  assert.equal(seen.seenAt[B], 500)
  assert.equal(kindOf(seen, B), 'idle')
  assert.equal(kindOf(run(seen, status(B, 2, { failures: 1 }, 500)), B), 'failed')
})

test('selecting the tab that is already selected also marks it as seen', () => {
  const failed = run(start(scan(live(A, 1))), status(A, 1, { failures: 1 }, NOW))
  assert.equal(kindOf(failed, A), 'failed')
  assert.equal(kindOf(select(A, 2000)(failed), A), 'idle')
})

test('an answer asked before the user selected the tab does not bring seen failures back', () => {
  const failed = run(start(scan(live(A, 1), live(B, 2))), status(B, 2, { failures: 2 }))
  const seen = select(B, 500)(failed)
  const late = run(seen, status(B, 2, { failures: 2, busy: 1 }, 400))
  assert.equal(kindOf(late, B), 'working', 'the rest of the late answer still counts')
  assert.equal(late.watched[B].failures, 0)
  const lateNeverAsked = run(seen, status(B, 2, { failures: 2 }))
  assert.equal(kindOf(lateNeverAsked, B), 'idle')
})

test('the automatic selection also marks the tab as seen', () => {
  const state = start(scan(live(A, 1)))
  assert.equal(state.seenAt[A], NOW)
})

test('a stopped tab has no status row, and a tab that returns is Unknown until its first answer', () => {
  const stopped = start(
    scan(live(A, 1), live(B, 2)),
    { type: 'rename', root: B, name: 'Website' },
    status(B, 2, { questions: 1 }),
    scan(live(A, 1)),
  )
  assert.equal(kindOf(stopped, B), undefined)
  assert.deepEqual(sidebarOf(stopped).ungrouped.find(({ root }) => root === B), { root: B, label: 'Website', port: null, selected: false, lifecycle: 'stopped', status: null, error: null })
  assert.equal(kindOf(run(stopped, scan(live(A, 1), live(B, 2))), B), 'unknown')
})

test('a project on a new port is Unknown, and a late answer from its old port is dropped', () => {
  const asking = start(scan(live(A, 1), live(B, 2)), status(B, 2, { questions: 1 }))
  const moved = run(asking, scan(live(A, 1), live(B, 9)))
  assert.equal(kindOf(moved, B), 'unknown')
  assert.equal(kindOf(run(moved, status(B, 2, { questions: 1 })), B), 'unknown')
  assert.equal(kindOf(run(moved, status(B, 9, { questions: 1 })), B), 'needs-you')
})

test('a scan keeps the status of a tab that stays on its port', () => {
  const state = start(scan(live(A, 1), live(B, 2)), status(B, 2, { busy: 1 }), scan(live(A, 1), live(B, 2)))
  assert.equal(kindOf(state, B), 'working')
})

test('a live tab is Unknown until its first answer, and Unknown is the last section', () => {
  const state = start(scan(live(A, 1), live(B, 2), live(C, 3)), status(C, 3, {}), status(B, 2, { busy: 1 }))
  assert.deepEqual(statusList(state), [['Working', ['beta']], ['Idle', ['gamma']], ['Unknown', ['alpha']]])
  assert.equal(kindOf(run(state, status(A, 1, { questions: 1 })), A), 'needs-you')
})

test('an answer counts for 60 seconds, then the tab is Unknown until the next answer', () => {
  const at = (now: number, command: Command) => (state: TabsState) => reduce(state, command, now)
  const answered = at(10000, status(B, 2, { busy: 1 }))(start(scan(live(A, 1), live(B, 2))))
  const after59 = at(10000 + 59000, scan(live(A, 1), live(B, 2)))(answered)
  assert.equal(kindOf(after59, B), 'working', 'an answer 59 seconds old still counts')
  const after61 = at(10000 + 61000, scan(live(A, 1), live(B, 2)))(after59)
  assert.equal(kindOf(after61, B), 'unknown', 'an answer 61 seconds old does not')
  assert.equal(kindOf(at(10000 + 62000, status(B, 2, { questions: 1 }))(after61), B), 'needs-you')
})

test('moving after a target keeps the tab next to it, ahead of later tabs in the saved order', () => {
  const state = start(scan(live(A, 1), live(B, 2), live(C, 3)), { type: 'move', root: A, target: B, place: 'after' })
  assert.deepEqual(labels(state), ['beta', 'alpha', 'gamma'])
  assert.deepEqual(labels(run(state, { type: 'move', root: A, target: '/p/gone', place: 'before' })), ['beta', 'alpha', 'gamma'])
})

test('a status answer with absent fields means zero', () => {
  assert.deepEqual(parseStatus('{"result":{}}'), { questions: 0, failures: 0, busy: 0 })
  assert.deepEqual(
    parseStatus('{"result":{"at":1,"questions":{"count":2,"first":{}},"failures":[{},{},{}],"busy":4,"extensions":[]}}'),
    { questions: 2, failures: 3, busy: 4 },
  )
  assert.deepEqual(parseStatus('{"result":{"questions":{},"busy":1}}'), { questions: 0, failures: 0, busy: 1 })
})

test('a status answer that is not the known format is an error, so the last status stays', () => {
  for (const text of ['', 'not json', '{}', '{"result":null}', '{"result":3}', '{"result":{"busy":"1"}}', '{"result":{"busy":-1}}', '{"result":{"failures":2}}', '{"result":{"questions":{"count":"2"}}}', '{"result":{"questions":3}}', '{"result":{"questions":null}}'])
    assert.throws(() => parseStatus(text), `should reject ${text}`)
})

const [G1, G2] = ['g-one', 'g-two'] as GroupId[]
const create = (id: GroupId, name: string): Command => ({ type: 'create-group', id, name })
const collapse = (id: GroupId, collapsed = true): Command => ({ type: 'collapse-group', id, collapsed })
const toGroup = (root: string, groupId: GroupId | null): Command => ({ type: 'move-to-group', root, groupId })
const pick = (root: string): Command => ({ type: 'select', root })
const topList = (state: TabsState) => {
  const { groups, ungrouped } = sidebarOf(state)
  return [...groups.map((group) => [group.name, group.collapsed ? [] : group.rows.map((row) => row.label)]), ['Ungrouped', ungrouped.map((row) => row.label)]]
}
const groupView = (state: TabsState, id: GroupId) => sidebarOf(state).groups.find((group) => group.id === id)!
const fourLive = scan(live(A, 1), live(B, 2), live(C, 3), live(D, 4))

test('a group name is trimmed, from 1 to 60 characters, unique in any letter case, and never Ungrouped', () => {
  const groups = [{ id: G1, name: 'Product', collapsed: false }]
  assert.equal(groupNameRefusal(groups, ''), 'empty')
  assert.equal(groupNameRefusal(groups, '   '), 'empty')
  assert.equal(groupNameRefusal(groups, 'x'.repeat(61)), 'too-long')
  assert.equal(groupNameRefusal(groups, `  ${'x'.repeat(60)}  `), null, 'spaces at the ends do not count')
  assert.equal(groupNameRefusal(groups, '🙂'.repeat(60)), null, 'an emoji counts as one character')
  assert.equal(groupNameRefusal(groups, 'PRODUCT'), 'taken')
  assert.equal(groupNameRefusal(groups, ' product '), 'taken')
  assert.equal(groupNameRefusal(groups, 'ungrouped'), 'taken')
  assert.equal(groupNameRefusal(groups, 'Ungrouped'), 'taken')
  assert.equal(groupNameRefusal(groups, 'Tools'), null)
  assert.equal(groupNameRefusal(groups, 'PRODUCT', G1), null, 'a group can rename itself in another letter case')
})

test('a new group goes to the end, expanded and empty, and the selection does not change', () => {
  const state = start(fourLive, pick(B), create(G1, '  Product  '), create(G2, 'Tools'))
  assert.deepEqual(state.saved.groups, [{ id: G1, name: 'Product', collapsed: false }, { id: G2, name: 'Tools', collapsed: false }])
  assert.deepEqual(topList(state), [['Product', []], ['Tools', []], ['Ungrouped', ['alpha', 'beta', 'gamma', 'delta']]])
  assert.deepEqual(groupView(state, G1), { id: G1, name: 'Product', collapsed: false, count: 0, hidesSelected: false, status: null, rows: [] })
  assert.equal(selectedRoot(state), B)
})

test('the reducer refuses a group name that the rule refuses, and an id that exists', () => {
  const state = start(fourLive, create(G1, 'Product'))
  for (const name of ['', '  ', 'x'.repeat(61), 'product', 'UNGROUPED'])
    assert.deepEqual(run(state, create(G2, name)).saved, state.saved, `refuses "${name}"`)
  assert.deepEqual(run(state, create(G1, 'Other')).saved, state.saved, 'refuses an id that exists')
})

test('a rename keeps the id and the members, uses the same rule, and an unknown id changes nothing', () => {
  const state = start(fourLive, create(G1, 'Product'), create(G2, 'Tools'), toGroup(A, G1))
  const renamed = run(state, { type: 'rename-group', id: G1, name: ' Website ' })
  assert.deepEqual(renamed.saved.groups[0], { id: G1, name: 'Website', collapsed: false })
  assert.deepEqual(topList(renamed)[0], ['Website', ['alpha']])
  assert.equal(run(state, { type: 'rename-group', id: G1, name: 'PRODUCT' }).saved.groups[0].name, 'PRODUCT')
  for (const name of ['', 'x'.repeat(61), 'tools', 'Ungrouped'])
    assert.deepEqual(run(state, { type: 'rename-group', id: G1, name }).saved, state.saved, `refuses "${name}"`)
  assert.deepEqual(run(state, { type: 'rename-group', id: 'gone' as GroupId, name: 'New' }).saved, state.saved)
})

test('Move to group puts the tab at the end of that group, or of Ungrouped, and keeps its name, page, and selection', () => {
  const state = start(fourLive, { type: 'rename', root: C, name: 'Website' }, pick(C), create(G1, 'Product'), toGroup(B, G1), toGroup(C, G1))
  assert.deepEqual(topList(state), [['Product', ['beta', 'Website']], ['Ungrouped', ['alpha', 'delta']]])
  const back = run(state, toGroup(B, null))
  assert.deepEqual(topList(back), [['Product', ['Website']], ['Ungrouped', ['alpha', 'delta', 'beta']]])
  assert.deepEqual(mainOf(state), { kind: 'page', root: C, port: 3 })
  assert.equal(selectedRoot(state), C)
  assert.deepEqual(run(state, toGroup(A, 'gone' as GroupId)).saved, state.saved, 'an unknown group changes nothing')
  assert.deepEqual(run(state, toGroup('/p/gone', G1)).saved, state.saved, 'an unknown tab changes nothing')
  assert.deepEqual(run(state, toGroup(D, null)).saved, state.saved, 'the last tab of a group stays where it is, and nothing is saved')
  assert.deepEqual(topList(run(state, toGroup(B, G1))), [['Product', ['Website', 'beta']], ['Ungrouped', ['alpha', 'delta']]])
})

test('a drop above or below a row puts the tab in that row\'s group, and a drop on an Ungrouped row takes it out', () => {
  const state = start(fourLive, create(G1, 'Product'), create(G2, 'Tools'), toGroup(A, G1), toGroup(B, G2))
  const intoTools = run(state, { type: 'move', root: C, target: B, place: 'before' })
  assert.deepEqual(topList(intoTools), [['Product', ['alpha']], ['Tools', ['gamma', 'beta']], ['Ungrouped', ['delta']]])
  const intoProduct = run(intoTools, { type: 'move', root: B, target: A, place: 'after' })
  assert.deepEqual(topList(intoProduct), [['Product', ['alpha', 'beta']], ['Tools', ['gamma']], ['Ungrouped', ['delta']]])
  const out = run(intoProduct, { type: 'move', root: A, target: D, place: 'after' })
  assert.deepEqual(topList(out), [['Product', ['beta']], ['Tools', ['gamma']], ['Ungrouped', ['delta', 'alpha']]])
  assert.deepEqual(run(out, { type: 'move', root: B, target: B, place: 'after' }).saved, out.saved, 'a drop on itself changes nothing')
})

test('removing a group moves its tabs to the end of Ungrouped in their order, and the selection stays', () => {
  const state = start(fourLive, create(G1, 'Product'), toGroup(C, G1), toGroup(A, G1), pick(A))
  assert.deepEqual(topList(state), [['Product', ['gamma', 'alpha']], ['Ungrouped', ['beta', 'delta']]])
  const removed = run(state, { type: 'remove-group', id: G1 })
  assert.deepEqual(removed.saved.groups, [])
  assert.deepEqual(topList(removed), [['Ungrouped', ['beta', 'delta', 'gamma', 'alpha']]])
  assert.equal(selectedRoot(removed), A)
  assert.deepEqual(removed.instances, state.instances)
  assert.deepEqual(run(state, { type: 'remove-group', id: 'gone' as GroupId }).saved, state.saved, 'an unknown group changes nothing')
})

test('an unnamed tab in a group stays dimmed in its place when it stops, and leaves the list once it is ungrouped and not selected', () => {
  const state = start(fourLive, create(G1, 'Product'), toGroup(B, G1), toGroup(C, G1), scan(live(A, 1), live(C, 3), live(D, 4)))
  assert.deepEqual(groupView(state, G1).rows, [
    { root: B, label: 'beta', port: null, selected: false, lifecycle: 'stopped', status: null, error: null },
    { root: C, label: 'gamma', port: 3, selected: false, lifecycle: 'running', status: 'unknown', error: null },
  ])
  assert.equal(groupView(state, G1).count, 2, 'the count holds live and dimmed rows')
  assert.equal(kindOf(state, B), undefined, 'a dimmed tab in a group has no status row')
  const ungrouped = run(state, pick(B), toGroup(B, null))
  assert.deepEqual(topList(ungrouped), [['Product', ['gamma']], ['Ungrouped', ['alpha', 'delta', 'beta']]], 'selected, so it stays')
  assert.deepEqual(topList(run(ungrouped, pick(A))), [['Product', ['gamma']], ['Ungrouped', ['alpha', 'delta']]])
  const removedGroup = run(state, { type: 'remove-group', id: G1 })
  assert.deepEqual(topList(removedGroup), [['Ungrouped', ['alpha', 'delta', 'gamma']]], 'the dimmed tab of a removed group leaves')
})

test('collapsing a group hides its rows, keeps the selection, the page, and its status rows, and marks the header', () => {
  const state = start(fourLive, create(G1, 'Product'), toGroup(B, G1), toGroup(C, G1), pick(C))
  const collapsed = run(state, collapse(G1))
  assert.deepEqual(topList(collapsed), [['Product', []], ['Ungrouped', ['alpha', 'delta']]])
  assert.equal(groupView(collapsed, G1).count, 2)
  assert.equal(groupView(collapsed, G1).hidesSelected, true)
  assert.equal(groupView(state, G1).hidesSelected, false, 'no marker while it is expanded')
  assert.equal(groupView(run(collapsed, pick(A)), G1).hidesSelected, false, 'no marker when the selection is elsewhere')
  assert.deepEqual(mainOf(collapsed), mainOf(state))
  assert.deepEqual(statusList(collapsed), statusList(state))
  assert.deepEqual(run(collapsed, collapse(G1)).saved, collapsed.saved, 'collapse sets a value, so a repeat changes nothing')
  assert.deepEqual(run(collapsed, collapse(G1, false)).saved, state.saved)
})

test('a select of a tab that has left the list changes nothing', () => {
  const state = start(fourLive, pick(B))
  assert.deepEqual(run(state, pick('/p/gone')), state)
})

test('each row carries its status, and a group carries the most urgent status of its rows, which the rail shows', () => {
  const grouped = start(fourLive, create(G1, 'Product'), toGroup(B, G1), toGroup(C, G1), status(B, 2, { busy: 1 }), status(C, 3, {}))
  const rowOf = (state: TabsState, root: string) => groupView(state, G1).rows.find((row) => row.root === root)!
  assert.equal(rowOf(grouped, B).status, 'working')
  assert.equal(rowOf(grouped, C).status, 'idle')
  assert.equal(groupView(grouped, G1).status, 'working')
  const asks = run(grouped, status(C, 3, { questions: 1 }))
  assert.equal(groupView(asks, G1).status, 'needs-you', 'Needs You comes before Working')
  const done = run(grouped, status(B, 2, {}))
  assert.equal(groupView(done, G1).status, 'done')
  const idle = run(done, pick(B))
  assert.equal(groupView(idle, G1).status, null, 'an idle group has no status to show')
  const stopped = run(idle, scan(live(A, 1), live(B, 2), live(D, 4)))
  assert.equal(rowOf(stopped, C).status, null, 'a project that is not running has no status')
  assert.equal(groupView(run(grouped, collapse(G1)), G1).status, 'working', 'collapse changes nothing')
})

test('selecting a tab expands its group, and scans, status answers, and the first selection never do', () => {
  const grouped = start(fourLive, create(G1, 'Product'), toGroup(C, G1), collapse(G1))
  assert.equal(run(grouped, pick(C)).saved.groups[0].collapsed, false, 'select reveals')
  const quiet = run(grouped, fourLive, status(C, 3, { questions: 1 }), scan(live(A, 1), live(B, 2), live(D, 4)), fourLive)
  assert.equal(quiet.saved.groups[0].collapsed, true)
  const first = run(initialState({ groups: [{ id: G1, name: 'Product', collapsed: true }], tabs: [saved(C, null, G1), saved(A)], zoom: 1, sidebar: 'full' }), scan(live(C, 3)))
  assert.equal(selectedRoot(first), C, 'the only live tab is selected')
  assert.equal(first.saved.groups[0].collapsed, true, 'and its group stays collapsed')
})

test('the first selection is the first live row on screen, past a collapsed group', () => {
  const groups = [{ id: G1, name: 'Product', collapsed: false }, { id: G2, name: 'Tools', collapsed: true }]
  const saved3 = { groups, tabs: [saved(A), saved(B, null, G2), saved(C, null, G1)], zoom: 1, sidebar: 'full' as const }
  assert.equal(selectedRoot(run(initialState(saved3), scan(live(A, 1), live(B, 2), live(C, 3)))), C, 'groups come before Ungrouped')
  assert.equal(selectedRoot(run(initialState(saved3), scan(live(A, 1), live(B, 2)))), A, 'a visible row before a row in a collapsed group')
})

test('Ctrl+Tab visits each visible top row once in screen order, and skips collapsed groups', () => {
  const state = start(fourLive, create(G1, 'Product'), create(G2, 'Tools'), toGroup(D, G1), toGroup(B, G2), toGroup(C, G1), pick(D))
  assert.deepEqual(topList(state), [['Product', ['delta', 'gamma']], ['Tools', ['beta']], ['Ungrouped', ['alpha']]])
  const walk = (from: TabsState, by: 1 | -1, steps: number) => {
    const visited: string[] = []
    for (let step = 0; step < steps; step++) visited.push(selectedLabel((from = run(from, { type: 'cycle', by })))!)
    return visited
  }
  assert.deepEqual(walk(state, 1, 4), ['gamma', 'beta', 'alpha', 'delta'])
  assert.deepEqual(walk(state, -1, 4), ['alpha', 'beta', 'gamma', 'delta'])
  const toolsShut = run(state, collapse(G2))
  assert.deepEqual(walk(toolsShut, 1, 3), ['gamma', 'alpha', 'delta'])
  assert.equal(toolsShut.saved.groups[1].collapsed, true, 'Ctrl+Tab does not expand a group')
})

test('with the selected tab in a collapsed group, Ctrl+Tab picks the first visible row and Ctrl+Shift+Tab the last', () => {
  const state = start(fourLive, create(G1, 'Product'), create(G2, 'Tools'), toGroup(D, G1), toGroup(B, G2), toGroup(C, G2), pick(D), collapse(G1))
  assert.deepEqual(topList(state), [['Product', []], ['Tools', ['beta', 'gamma']], ['Ungrouped', ['alpha']]])
  assert.equal(selectedRoot(run(state, { type: 'cycle', by: 1 })), B)
  assert.equal(selectedRoot(run(state, { type: 'cycle', by: -1 })), A)
  const nothingShows = run(start(scan(live(A, 1)), create(G1, 'Product'), toGroup(A, G1), collapse(G1)), { type: 'cycle', by: 1 })
  assert.equal(selectedRoot(nothingShows), A, 'no visible top row: the selection does not change')
  assert.equal(nothingShows.saved.groups[0].collapsed, true)
})

test('the Status list follows the screen order of the top list, also for rows in a collapsed group', () => {
  const state = start(fourLive, create(G1, 'Product'), toGroup(D, G1), toGroup(B, G1), status(A, 1, { busy: 1 }), status(B, 2, { busy: 1 }), status(D, 4, { busy: 1 }))
  assert.deepEqual(statusList(state), [['Working', ['delta', 'beta', 'alpha']], ['Unknown', ['gamma']]])
  assert.deepEqual(statusList(run(state, collapse(G1))), statusList(state))
})

test('a new project goes to the end of Ungrouped when groups exist', () => {
  const state = start(scan(live(A, 1)), create(G1, 'Product'), toGroup(A, G1), scan(live(A, 1), live(B, 2)))
  assert.deepEqual(topList(state), [['Product', ['alpha']], ['Ungrouped', ['beta']]])
  assert.deepEqual(state.saved.tabs.at(-1), saved(B))
})

test('groups, names, membership, order, and collapsed states survive a save and reload', () => {
  const before = start(fourLive, create(G1, 'Product'), create(G2, 'Tools'), { type: 'rename', root: A, name: 'Website' }, toGroup(C, G1), toGroup(A, G1), toGroup(D, G2), collapse(G2))
  const after = run(initialState(parseSaved(JSON.parse(JSON.stringify(before.saved)))), fourLive)
  assert.deepEqual(after.saved, before.saved)
  assert.deepEqual(topList(after), [['Product', ['gamma', 'Website']], ['Tools', []], ['Ungrouped', ['beta']]])
})

test('tabs.json must be { groups, tabs }: the old array is corrupt, and a groupId that names no group reads as Ungrouped', () => {
  const good = {
    groups: [{ id: 'g-one', name: 'Product', collapsed: true }],
    tabs: [{ root: A, name: null, groupId: 'g-one' }, { root: B, name: 'Website', groupId: null }, { root: C, name: null, groupId: 'g-gone' }],
  }
  assert.deepEqual(parseSaved(good), { groups: good.groups, tabs: [saved(A, null, G1), saved(B, 'Website'), saved(C)], zoom: 1, sidebar: 'full' })
  assert.deepEqual(parseSaved({ groups: [], tabs: [] }), savedOf())
  for (const bad of [[{ root: A, name: null }], [], null, 3, {}, { groups: [] }, { tabs: [] }, { groups: [{ id: 'g', name: 'x' }], tabs: [] }, { groups: [], tabs: [{ root: A, name: null }] }, { groups: [], tabs: [{ root: 1, name: null, groupId: null }] }])
    assert.throws(() => parseSaved(bad), `should reject ${JSON.stringify(bad)}`)
})

test('zoom walks Chrome steps, stops at both ends, and Actual Size is 1', () => {
  const walk = (step: 'in' | 'out', from: number) => {
    const seen = [from]
    for (let next = zoomed(from, step); next !== seen.at(-1); next = zoomed(next, step)) seen.push(next)
    return seen
  }
  assert.deepEqual(walk('in', 1), [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5])
  assert.deepEqual(walk('out', 1), [1, 0.9, 0.8, 0.75, 0.67, 0.5, 0.33, 0.25])
  assert.equal(zoomed(1.3, 'in'), 1.5, 'a value between steps goes to the next step')
  assert.equal(zoomed(1.3, 'out'), 1.25)
  for (const factor of ZOOM_STEPS) assert.equal(zoomed(factor, 'reset'), 1)
})

test('the zoom command changes only the saved zoom, and survives a save and reload', () => {
  const before = start(scan(live(A, 1), live(B, 2)), create(G1, 'Product'), toGroup(B, G1))
  const after = run(before, { type: 'zoom', step: 'in' }, { type: 'zoom', step: 'in' })
  assert.deepEqual(after, { ...before, saved: { ...before.saved, zoom: 1.25 } })
  assert.deepEqual(parseSaved(JSON.parse(JSON.stringify(after.saved))), after.saved)
  assert.equal(run(after, { type: 'zoom', step: 'reset' }).saved.zoom, 1)
  const kept = run(after, { type: 'rename', root: A, name: 'Website' }, toGroup(A, G1), { type: 'remove-group', id: G1 }, collapse(G1))
  assert.equal(kept.saved.zoom, 1.25, 'tab and group commands keep the zoom')
})

test('tabs.json without zoom, or with a bad zoom, reads as actual size and keeps its tabs', () => {
  const tabs = [{ root: A, name: 'Website', groupId: null, lifecycle: null }]
  for (const zoom of [undefined, null, '1.5', 0, 0.1, 6, Number.NaN, {}])
    assert.deepEqual(parseSaved({ groups: [], tabs, zoom }), { groups: [], tabs, zoom: 1, sidebar: 'full' }, `zoom ${String(zoom)}`)
  assert.equal(parseSaved({ groups: [], tabs, zoom: 0.25 }).zoom, 0.25)
  assert.equal(parseSaved({ groups: [], tabs, zoom: 5 }).zoom, 5)
})

test('toggle-sidebar changes only the saved form, shows in the sidebar view, and survives a save and reload', () => {
  const before = start(scan(live(A, 1), live(B, 2)), create(G1, 'Product'), toGroup(B, G1))
  const rail = run(before, { type: 'toggle-sidebar' })
  assert.deepEqual(rail, { ...before, saved: { ...before.saved, sidebar: 'rail' } })
  assert.equal(sidebarOf(rail).form, 'rail')
  assert.deepEqual(parseSaved(JSON.parse(JSON.stringify(rail.saved))), rail.saved)
  assert.equal(sidebarWidth(rail.saved.sidebar), RAIL_WIDTH)
  const kept = run(rail, { type: 'rename', root: A, name: 'Website' }, toGroup(A, G1), { type: 'zoom', step: 'in' }, collapse(G1))
  assert.equal(kept.saved.sidebar, 'rail', 'tab, group, and zoom commands keep the form')
  assert.deepEqual(run(rail, { type: 'toggle-sidebar' }), before)
  assert.equal(sidebarWidth(before.saved.sidebar), SIDEBAR_WIDTH)
})

test('tabs.json without a sidebar form, or with a bad one, reads as full and keeps its tabs', () => {
  const tabs = [{ root: A, name: 'Website', groupId: null, lifecycle: null }]
  for (const sidebar of [undefined, null, 'hidden', true, 40, {}])
    assert.deepEqual(parseSaved({ groups: [], tabs, zoom: 1, sidebar }), { groups: [], tabs, zoom: 1, sidebar: 'full' }, `sidebar ${String(sidebar)}`)
  assert.equal(parseSaved({ groups: [], tabs, zoom: 1, sidebar: 'rail' }).sidebar, 'rail')
})

const [CLIENTS, TOOLS] = ['g-clients', 'g-tools'] as GroupId[]
/** Clients (collapsed): billing, site. Tools: Site Kit. Ungrouped: alpha, /q/site. Named "Stopped" is dimmed. */
function searchState() {
  return start(
    scan(live('/w/billing', 1), live('/w/site', 2), live('/w/sitekit', 3), live(A, 4), live('/q/site', 5), live('/w/stopped', 6)),
    { type: 'rename', root: '/w/sitekit', name: 'Site Kit' },
    { type: 'rename', root: '/w/stopped', name: 'Stopped' },
    { type: 'create-group', id: CLIENTS, name: 'Clients' },
    { type: 'create-group', id: TOOLS, name: 'Tools' },
    { type: 'move-to-group', root: '/w/billing', groupId: CLIENTS },
    { type: 'move-to-group', root: '/w/site', groupId: CLIENTS },
    { type: 'move-to-group', root: '/w/sitekit', groupId: TOOLS },
    { type: 'move-to-group', root: '/w/stopped', groupId: TOOLS },
    { type: 'collapse-group', id: CLIENTS, collapsed: true },
    scan(live('/w/billing', 1), live('/w/site', 2), live('/w/sitekit', 3), live(A, 4), live('/q/site', 5)),
  )
}
const found = (state: TabsState, query: string) => searchOf(sidebarOf(state), query).map(({ root, group }) => `${root} ${group}`)

test('an empty query lists each live tab once in sidebar order, also in a collapsed group, and never a stopped tab', () => {
  const state = searchState()
  assert.equal(sidebarOf(state).groups[0].collapsed, true)
  assert.deepEqual(found(state, '   '), ['/w/billing Clients', '/w/site Clients', '/w/sitekit Tools', `${A} Ungrouped`, '/q/site Ungrouped'])
  assert.ok(searchOf(sidebarOf(state), '').every(({ marks }) => Object.values(marks).every((spans) => spans.length === 0)))
  assert.deepEqual(found(state, 'stopped'), [])
  assert.deepEqual(searchOf(sidebarOf(start(scan())), ''), [])
})

test('search matches the name, the path, and the group name, in any letter case, with each term in any field', () => {
  const state = searchState()
  assert.deepEqual(found(state, 'BILL'), ['/w/billing Clients'])
  assert.deepEqual(found(state, '/Q/'), ['/q/site Ungrouped'])
  assert.deepEqual(found(state, 'clients'), ['/w/billing Clients', '/w/site Clients'])
  assert.deepEqual(found(state, 'ungrouped ALPHA'), [`${A} Ungrouped`])
  assert.deepEqual(found(state, '  tools   /w/  '), ['/w/sitekit Tools'])
  assert.deepEqual(found(state, 'clients alpha'), [])
  assert.deepEqual(found(state, 'w.s'), [], 'a dot is a dot, not any character')
})

test('a full name match ranks first, then a name prefix, then other matches, each in sidebar order', () => {
  const state = searchState()
  assert.deepEqual(found(state, 'site'), ['/w/site Clients', '/q/site Ungrouped', '/w/sitekit Tools'])
  assert.deepEqual(found(state, 'SITE KIT'), ['/w/sitekit Tools'])
  assert.deepEqual(found(state, 'it'), ['/w/site Clients', '/w/sitekit Tools', '/q/site Ungrouped'])
  const expanded = run(state, { type: 'collapse-group', id: CLIENTS, collapsed: false })
  assert.deepEqual(found(expanded, 'site'), found(state, 'site'), 'collapse changes no match and no rank')
})

test('marks cover each place where a term occurs in each field, and overlaps merge', () => {
  const state = searchState()
  const results = searchOf(sidebarOf(state), 'kit T')
  assert.deepEqual(results.map(({ root }) => root), ['/w/sitekit'])
  assert.deepEqual(results[0].marks, {
    name: [{ start: 2, end: 3 }, { start: 5, end: 8 }],
    group: [{ start: 0, end: 1 }],
    path: [{ start: 5, end: 6 }, { start: 7, end: 10 }],
  })
  const [billing] = searchOf(sidebarOf(state), 'll lli')
  assert.deepEqual(billing.marks.name, [{ start: 2, end: 5 }])
})

test('two tabs with the same name give two results that the path tells apart', () => {
  const results = searchOf(sidebarOf(searchState()), 'site')
  assert.deepEqual(results.slice(0, 2).map(({ name, root }) => [name, root]), [['site', '/w/site'], ['site', '/q/site']])
})

test('the active result keeps its root, else takes the result now at its place, else the last', () => {
  const of = (...roots: string[]) => roots.map((root) => ({ root }) as SearchResult)
  assert.equal(activeAfter(of(A, B, C), of(C, A), A), A)
  assert.equal(activeAfter(of(A, B, C), of(A, C, D), B), C)
  assert.equal(activeAfter(of(A, B, C), of(A, B), C), B)
  assert.equal(activeAfter(of(A, B), of(), A), null)
  assert.equal(activeAfter(of(), of(B, C), null), B)
})

test('move-group puts a group before or after another, keeps its tabs and collapse, and refuses unknown groups', () => {
  const [g1, g2, g3] = ['g1', 'g2', 'g3'] as GroupId[]
  const before = run(
    start(scan(live(A, 1), live(B, 2))),
    { type: 'create-group', id: g1, name: 'One' },
    { type: 'create-group', id: g2, name: 'Two' },
    { type: 'create-group', id: g3, name: 'Three' },
    { type: 'move-to-group', root: A, groupId: g1 },
    { type: 'collapse-group', id: g1, collapsed: true },
  )
  const names = (state: TabsState) => sidebarOf(state).groups.map(({ name, collapsed, rows }) => [name, collapsed, rows.map((row) => row.label)])
  assert.deepEqual(names(run(before, { type: 'move-group', id: g1, target: g3, place: 'after' })), [['Two', false, []], ['Three', false, []], ['One', true, ['alpha']]])
  assert.deepEqual(names(run(before, { type: 'move-group', id: g3, target: g1, place: 'before' })), [['Three', false, []], ['One', true, ['alpha']], ['Two', false, []]])
  assert.deepEqual(names(run(before, { type: 'move-group', id: g1, target: g2, place: 'before' })), names(before), 'already there')
  assert.equal(run(before, { type: 'move-group', id: g1, target: g1, place: 'after' }).saved, before.saved, 'onto itself')
  assert.equal(run(before, { type: 'move-group', id: 'gone' as GroupId, target: g1, place: 'after' }).saved, before.saved)
  assert.equal(run(before, { type: 'move-group', id: g1, target: 'gone' as GroupId, place: 'after' }).saved, before.saved)
})

const LAUNCHER = { node: '/n/bin/node', entry: '/u/bin/ultimate.ts' }
const id = (name: string) => name as OperationId
const act = (root: string, action: LifecycleAction, op = id(`${action}-${root}`)): Command => ({ type: 'lifecycle', root, id: op, action })
const confirmed = (root: string, op: OperationId, launcher: typeof LAUNCHER | null = LAUNCHER): Command => ({ type: 'lifecycle-confirmed', root, id: op, launcher })
const stopped = (root: string, op: OperationId, replaced = false): Command => ({ type: 'lifecycle-stopped', root, id: op, replaced })
const failed = (root: string, op: OperationId, error: string | null, before: boolean): Command => ({ type: 'lifecycle-failed', root, id: op, error, before })
const rowOf = (state: TabsState, root: string) => {
  const { groups, ungrouped } = sidebarOf(state)
  return [...groups.flatMap(({ rows }) => rows), ...ungrouped].find((row) => row.root === root)
}
const recordOf = (state: TabsState, root: string) => state.saved.tabs.find((tab) => tab.root === root)?.lifecycle
const P = id('pause-/p/beta')
const pausing = () => start(scan(live(A, 1), live(B, 2), live(C, 3)), act(B, 'pause'), confirmed(B, P))
const paused = () => run(pausing(), scan(live(A, 1), live(C, 3)), stopped(B, P))

test('lifecycle: pause and close need a running row, play needs a paused row, and the check before a question shows nothing', () => {
  const running = start(scan(live(A, 1), live(B, 2)))
  const checking = run(running, act(B, 'pause'))
  assert.deepEqual(checking.operations[B], { id: P, action: 'pause', phase: 'checking', late: false })
  assert.equal(rowOf(checking, B)?.lifecycle, 'running', 'the check before a question is never shown')
  assert.equal(run(running, act(B, 'play')).operations[B], undefined, 'play refused on a running row')
  const named = run(running, { type: 'rename', root: B, name: 'Website' }, scan(live(A, 1)))
  assert.equal(rowOf(named, B)?.lifecycle, 'stopped')
  for (const action of ['pause', 'close', 'play'] as const)
    assert.equal(run(named, act(B, action)).operations[B], undefined, `${action} refused on a row that stopped outside Hub`)
  assert.equal(run(running, act('/p/unknown', 'pause')).operations['/p/unknown'], undefined, 'an unknown root is refused')
  const onPaused = paused()
  for (const action of ['pause', 'close'] as const) assert.equal(run(onPaused, act(B, action)).operations[B], undefined, `${action} refused on a paused row`)
  assert.equal(run(onPaused, act(B, 'play')).operations[B]?.action, 'play')
})

test('lifecycle: a second action on the same root is refused while one runs, and other roots are independent', () => {
  const state = run(pausing(), act(B, 'close', id('second')), act(B, 'pause', id('third')), act(A, 'pause', id('other')))
  assert.equal(state.operations[B].id, P)
  assert.equal(state.operations[A].id, id('other'))
})

test('lifecycle: confirming pause saves the launcher, the row shows stopping, and it leaves the Status list at once', () => {
  const state = pausing()
  assert.deepEqual(recordOf(state, B), { kind: 'paused', launcher: LAUNCHER })
  assert.equal(rowOf(state, B)?.lifecycle, 'stopping')
  assert.equal(rowOf(state, B)?.port, 2)
  assert.deepEqual(statusList(state), [['Unknown', ['alpha', 'gamma']]])
  assert.deepEqual(searchOf(sidebarOf(state), '').map(({ root }) => root), [A, C], 'nor is it a search result')
  const selected = run(state, { type: 'select', root: B })
  assert.deepEqual(mainOf(selected), { kind: 'message', root: B, label: 'beta', lifecycle: 'stopping', error: null })
  assert.equal(run(start(scan(live(B, 2))), act(B, 'pause'), confirmed(B, P, null)).operations[B].phase, 'checking', 'pause needs a launcher')
})

test('lifecycle: confirming close saves a closing record, and confirming play saves nothing', () => {
  const close = id('close-/p/beta')
  const closing = run(start(scan(live(A, 1), live(B, 2))), act(B, 'close'), confirmed(B, close, null))
  assert.deepEqual(recordOf(closing, B), { kind: 'closing' })
  assert.equal(rowOf(closing, B)?.lifecycle, 'closing')
  const play = id('play-/p/beta')
  const starting = run(paused(), act(B, 'play'), confirmed(B, play, null))
  assert.deepEqual(recordOf(starting, B), { kind: 'paused', launcher: LAUNCHER })
  assert.equal(rowOf(starting, B)?.lifecycle, 'starting')
})

test('lifecycle: a play shows starting from the click, before its checks end', () => {
  assert.equal(rowOf(run(paused(), act(B, 'play')), B)?.lifecycle, 'starting')
})

const add = (root: string, launcher: typeof LAUNCHER | null = LAUNCHER): Command => ({ type: 'add', root, launcher })

test('add: a new stopped project goes to the end of Ungrouped, selected, with the record that Play starts from', () => {
  const state = run(start(scan(live(A, 1))), { type: 'create-group', id: 'g' as GroupId, name: 'Work' }, { type: 'move-to-group', root: A, groupId: 'g' as GroupId }, add(D))
  assert.equal(state.selected, D)
  assert.deepEqual(state.saved.tabs.at(-1), { root: D, name: null, groupId: null, lifecycle: { kind: 'paused', launcher: LAUNCHER } })
  assert.deepEqual(sidebarOf(state).ungrouped.map((row) => [row.label, row.lifecycle]), [['delta', 'paused']])
  assert.equal(run(state, act(D, 'play')).operations[D]?.action, 'play', 'Play accepts it')
})

test('add: a running project is only selected, and its collapsed group opens', () => {
  const group = 'g' as GroupId
  const before = run(
    start(scan(live(A, 1), live(B, 2))),
    { type: 'create-group', id: group, name: 'Work' },
    { type: 'move-to-group', root: B, groupId: group },
    { type: 'collapse-group', id: group, collapsed: true },
    { type: 'select', root: A },
  )
  const state = run(before, add(B))
  assert.equal(state.selected, B)
  assert.deepEqual(state.saved.tabs, before.saved.tabs)
  assert.equal(state.saved.groups[0].collapsed, false)
})

test('add: a known project keeps its name, group, and place, and a busy or recorded one keeps its record', () => {
  const named = run(start(scan(live(A, 1), live(B, 2))), { type: 'rename', root: A, name: 'Site' }, scan(live(B, 2)))
  const state = run(named, add(A))
  assert.deepEqual(state.saved.tabs[0], { root: A, name: 'Site', groupId: null, lifecycle: { kind: 'paused', launcher: LAUNCHER } })
  const other = { node: '/other/node', entry: '/other/bin/ultimate.ts' }
  assert.deepEqual(recordOf(run(paused(), add(B, other)), B), { kind: 'paused', launcher: LAUNCHER }, 'a paused record stays')
  assert.equal(recordOf(run(pausing(), add(B, other)), B)?.kind, 'paused', 'an operation keeps its record')
  assert.equal(recordOf(run(named, add(A, null)), A), null, 'no launcher, no record')
})

test('lifecycle: a stopped pause shows play, keeps an unnamed unselected row in place, and survives a restart', () => {
  const state = paused()
  assert.equal(state.operations[B], undefined)
  assert.deepEqual(labels(state), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(rowOf(state, B), { root: B, label: 'beta', port: null, selected: false, lifecycle: 'paused', status: null, error: null })
  assert.equal(selectedLabel(state), 'alpha', 'the selection did not move')
  const reopened = run(initialState(parseSaved(JSON.parse(JSON.stringify(state.saved)))), scan(live(A, 1), live(C, 3)))
  assert.deepEqual(labels(reopened), ['alpha', 'beta', 'gamma'])
  assert.equal(rowOf(reopened, B)?.lifecycle, 'paused')
  assert.deepEqual(statusList(reopened), [['Unknown', ['alpha', 'gamma']]])
})

test('lifecycle: a pause whose root runs again after the exit adopts the new instance and clears the record', () => {
  const state = run(pausing(), scan(live(A, 1), live(B, 9), live(C, 3)), stopped(B, P, true))
  assert.equal(recordOf(state, B), null)
  assert.equal(rowOf(state, B)?.lifecycle, 'running')
  assert.equal(rowOf(state, B)?.port, 9)
})

test('lifecycle: play ends with the record cleared, and the selection never changes during a stop or start', () => {
  const play = id('play-/p/beta')
  const selected = run(paused(), { type: 'select', root: C })
  const starting = run(selected, act(B, 'play'), confirmed(B, play))
  assert.equal(selectedLabel(starting), 'gamma')
  const running = run(starting, scan(live(A, 1), live(B, 7), live(C, 3)))
  assert.equal(rowOf(running, B)?.lifecycle, 'starting', 'still starting until the status action answers')
  const done = run(running, { type: 'lifecycle-started', root: B, id: play })
  assert.equal(recordOf(done, B), null)
  assert.equal(done.operations[B], undefined)
  assert.deepEqual(rowOf(done, B), { root: B, label: 'beta', port: 7, selected: false, lifecycle: 'running', status: 'unknown', error: null })
  assert.equal(selectedLabel(done), 'gamma')
})

test('lifecycle: a confirmed close removes the tab, keeps its empty group, and moves the selection to the next row, then the previous', () => {
  const groups = [{ id: G1, name: 'Product', collapsed: false }]
  const base = run(initialState({ groups, tabs: [saved(A), saved(B, null, G1), saved(C)], zoom: 1, sidebar: 'full' }), scan(live(A, 1), live(B, 2), live(C, 3)))
  const close = id('close-/p/beta')
  const onB = run(base, { type: 'select', root: B }, act(B, 'close'), confirmed(B, close, null), scan(live(A, 1), live(C, 3)))
  assert.equal(rowOf(onB, B)?.lifecycle, 'closing', 'the row stays until the exit is proven')
  const closed = run(onB, stopped(B, close))
  assert.deepEqual(closed.saved.tabs.map(({ root }) => root), [A, C])
  assert.deepEqual(closed.saved.groups, groups)
  assert.equal(selectedLabel(closed), 'alpha', 'Product holds beta, so the next visible row is alpha in Ungrouped')
  const last = run(base, { type: 'select', root: C }, act(C, 'close', close), confirmed(C, close, null), scan(live(A, 1), live(B, 2)), stopped(C, close))
  assert.equal(selectedLabel(last), 'alpha', 'gamma was last, so the previous row is selected')
  const unselected = run(base, { type: 'select', root: A }, act(C, 'close', close), confirmed(C, close, null), scan(live(A, 1), live(B, 2)), stopped(C, close))
  assert.equal(selectedLabel(unselected), 'alpha', 'closing an unselected row keeps the selection')
  const only = run(start(scan(live(A, 1))), act(A, 'close', close), confirmed(A, close, null), scan(), stopped(A, close))
  assert.deepEqual(mainOf(only), { kind: 'empty' })
})

test('lifecycle: a close whose root runs again keeps the row, clears the record, and says that the instance changed', () => {
  const close = id('close-/p/beta')
  const state = run(start(scan(live(A, 1), live(B, 2))), act(B, 'close'), confirmed(B, close, null), scan(live(A, 1), live(B, 5)), stopped(B, close, true))
  assert.equal(recordOf(state, B), null)
  assert.deepEqual(rowOf(state, B), { root: B, label: 'beta', port: 5, selected: false, lifecycle: 'running', status: 'unknown', error: INSTANCE_CHANGED })
  assert.equal(run(state, act(B, 'pause', id('next'))).errors[B], undefined, 'the next action clears the error')
})

test('lifecycle: a failure before the signal removes the saved record, a failed start keeps it, and a cancel changes nothing', () => {
  const beforeSignal = run(pausing(), failed(B, P, 'The process changed.', true))
  assert.equal(recordOf(beforeSignal, B), null)
  assert.equal(rowOf(beforeSignal, B)?.lifecycle, 'running')
  assert.equal(rowOf(beforeSignal, B)?.error, 'The process changed.')
  const cancelled = run(start(scan(live(A, 1), live(B, 2))), act(B, 'pause'), failed(B, P, null, true))
  assert.deepEqual(cancelled, start(scan(live(A, 1), live(B, 2))))
  const play = id('play-/p/beta')
  const startFailed = run(paused(), act(B, 'play'), confirmed(B, play), failed(B, play, 'exited with code 1', true))
  assert.deepEqual(recordOf(startFailed, B), { kind: 'paused', launcher: LAUNCHER })
  assert.equal(rowOf(startFailed, B)?.lifecycle, 'paused')
  assert.deepEqual(mainOf(run(startFailed, { type: 'select', root: B })), { kind: 'message', root: B, label: 'beta', lifecycle: 'paused', error: 'exited with code 1' })
})

test('lifecycle: late marks the operation and shows the error while the controls stay busy', () => {
  const late = run(pausing(), { type: 'lifecycle-late', root: B, id: P, error: 'Not stopped after 15 s.' })
  assert.deepEqual(late.operations[B], { id: P, action: 'pause', phase: 'acting', late: true })
  assert.equal(rowOf(late, B)?.lifecycle, 'stopping')
  assert.equal(rowOf(late, B)?.error, 'Not stopped after 15 s.')
  assert.equal(run(late, act(B, 'pause', id('again'))).operations[B].id, P)
})

test('lifecycle: a result with an old operation id changes nothing', () => {
  const state = pausing()
  const stale = id('old')
  for (const command of [confirmed(B, stale), stopped(B, stale), stopped(B, stale, true), failed(B, stale, 'x', true), { type: 'lifecycle-started', root: B, id: stale } as Command, { type: 'lifecycle-late', root: B, id: stale, error: 'x' } as Command])
    assert.deepEqual(run(state, command), state, command.type)
  const afterEnd = paused()
  assert.deepEqual(run(afterEnd, stopped(B, P, true)), afterEnd, 'a repeated result for an ended operation')
})

test('lifecycle: on a fresh scan a running instance wins over a saved record, and a closing record without one is removed', () => {
  const saved0 = savedOf(
    { ...saved(A), lifecycle: { kind: 'paused', launcher: LAUNCHER } },
    { ...saved(B), lifecycle: { kind: 'closing' } },
    { ...saved(C), lifecycle: { kind: 'paused', launcher: LAUNCHER } },
    { ...saved(D, 'Docs'), lifecycle: { kind: 'closing' } },
  )
  const before = initialState(saved0)
  assert.deepEqual(labels(before), ['alpha', 'beta', 'gamma', 'Docs'], 'records keep rows visible before the first scan')
  const notFresh = run(before, { type: 'scan', instances: [live(A, 1)], fresh: false })
  assert.deepEqual(notFresh.saved, saved0, 'a scan that is not fresh changes no record')
  const state = run(before, scan(live(A, 1), live(B, 2)))
  assert.deepEqual(
    state.saved.tabs.map(({ root, lifecycle }) => [root, lifecycle?.kind ?? null]),
    [[A, null], [B, null], [C, 'paused']],
  )
  assert.equal(rowOf(state, C)?.lifecycle, 'paused')
})

test('lifecycle: the scan rules leave a tab with an operation to that operation', () => {
  const play = id('play-/p/beta')
  const starting = run(paused(), act(B, 'play'), confirmed(B, play), scan(live(A, 1), live(B, 7), live(C, 3)))
  assert.deepEqual(recordOf(starting, B), { kind: 'paused', launcher: LAUNCHER })
  const close = id('close-/p/beta')
  const closing = run(start(scan(live(A, 1), live(B, 2))), act(B, 'close'), confirmed(B, close, null), scan(live(A, 1)))
  assert.deepEqual(recordOf(closing, B), { kind: 'closing' })
})

test('lifecycle: remove is refused during an operation and removes a paused row', () => {
  const play = id('play-/p/beta')
  const starting = run(paused(), act(B, 'play'), confirmed(B, play))
  assert.deepEqual(run(starting, { type: 'remove', root: B }).saved, starting.saved)
  const checking = run(paused(), act(B, 'play'))
  assert.deepEqual(run(checking, { type: 'remove', root: B }).saved, checking.saved)
  assert.deepEqual(run(paused(), { type: 'remove', root: B }).saved.tabs.map(({ root }) => root), [A, C])
})

test('tabs.json lifecycle records: a missing record reads as none, and a bad one is corrupt', () => {
  const tab = (lifecycle: unknown) => ({ groups: [], tabs: [{ root: A, name: null, groupId: null, lifecycle }] })
  assert.equal(parseSaved(tab(undefined)).tabs[0].lifecycle, null)
  assert.deepEqual(parseSaved(tab({ kind: 'closing' })).tabs[0].lifecycle, { kind: 'closing' })
  assert.deepEqual(parseSaved(tab({ kind: 'paused', launcher: LAUNCHER, extra: 1 })).tabs[0].lifecycle, { kind: 'paused', launcher: LAUNCHER })
  for (const bad of [{ kind: 'paused' }, { kind: 'paused', launcher: { node: 'node', entry: '/u/bin/ultimate.ts' } }, { kind: 'stop-requested' }, 'paused'])
    assert.throws(() => parseSaved(tab(bad)), `should reject ${JSON.stringify(bad)}`)
})
