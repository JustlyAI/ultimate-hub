import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { folderName, portOf, type Command, type Launcher, type LifecycleAction, type OperationId, type TabsState } from '../shared/tabs'
import type { Sheet } from '../shared/menu'
import { exited, findProject, readLauncher, signalSupervisor, startSupervisor, statusAnswers, verifyLauncher, verifySupervisor, type Scan } from './ultimate'

const STOP_LATE_MS = 15000
const START_LATE_MS = 30000
const EXIT_POLL_MS = 100

const START_NEW = 'Ultimate has not run in this folder or in a folder in it. Start a new Ultimate here?'
const NO_LAUNCHER = 'Hub starts Ultimate the way a running or paused one was started. Start one Ultimate from a terminal, then try again.'

const PAUSE_WARNING =
  'This stops the server and interrupts active work. When it starts again, Ultimate continues interrupted work from its last checkpoint.'
const CLOSE_WARNING =
  'This stops the server and removes it from Hub. Active work can be interrupted. Project files and saved conversations are not deleted.'

type Deps = {
  state: () => TabsState
  /** Returns whether tabs.json now holds the state. */
  dispatch: (command: Command) => boolean
  /** A scan that starts after the call. Scans run one at a time, so no older scan can arrive after it. */
  nextScan: () => Promise<Scan>
  /** Resolves true only for the action button. */
  ask: (sheet: Sheet) => Promise<boolean>
  log: (line: string) => void
  logFolder: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
const runs = (scan: Scan, root: string) => scan.instances.find((instance) => instance.root === root)

/** Runs one operation for each user action. The reducer refuses a second one on the same root. */
export function createLifecycle({ state, dispatch, nextScan, ask, log, logFolder }: Deps) {
  const labelOf = (root: string) => state().saved.tabs.find((tab) => tab.root === root)?.name ?? folderName(root)
  const isCurrent = (root: string, id: OperationId) => state().operations[root]?.id === id

  async function freshScan(): Promise<Scan> {
    for (;;) {
      const scan = await nextScan()
      if (scan.fresh) return scan
    }
  }

  function late(root: string, id: OperationId, ms: number, error: string) {
    return setTimeout(() => dispatch({ type: 'lifecycle-late', root, id, error }), ms)
  }

  async function refuse(root: string, id: OperationId, action: LifecycleAction, error: unknown, before: boolean) {
    const text = reason(error)
    log(`${action} ${root}: ${text}`)
    dispatch({ type: 'lifecycle-failed', root, id, error: text, before })
    if (before) await ask({ icon: 'warning', title: `Hub could not ${action === 'play' ? 'start' : action} ${labelOf(root)}`, text, path: root, action: null })
  }

  async function stop(root: string, id: OperationId, action: 'pause' | 'close') {
    let signalled = false
    try {
      const target = await verifySupervisor(root, log)
      const launcher = action === 'pause' ? await readLauncher(target) : null
      const label = labelOf(root)
      const sure = await ask(
        action === 'pause'
          ? { icon: 'pause', title: `Pause ${label}?`, text: PAUSE_WARNING, path: root, action: 'Pause server' }
          : { icon: 'close', title: `Close ${label}?`, text: CLOSE_WARNING, path: root, action: 'Close Ultimate' },
      )
      if (!sure) return void dispatch({ type: 'lifecycle-failed', root, id, error: null, before: true })
      const again = await verifySupervisor(root, log)
      if (again.pid !== target.pid || again.start !== target.start) throw new Error('The Ultimate changed while the dialog was open.')
      const saved = dispatch({ type: 'lifecycle-confirmed', root, id, launcher })
      if (!saved || state().operations[root]?.phase !== 'acting' || !isCurrent(root, id))
        throw new Error('Hub could not save tabs.json, so it did not stop the server.')
      await signalSupervisor(target)
      signalled = true
      log(`${action} ${root}: SIGTERM to supervisor ${target.pid}`)
      const timer = late(root, id, STOP_LATE_MS, 'The server has not stopped after 15 seconds. Hub is still waiting and does not send another signal.')
      try {
        while (!(await exited(target).catch(() => false))) await sleep(EXIT_POLL_MS)
        const scan = await freshScan()
        dispatch({ type: 'lifecycle-stopped', root, id, replaced: runs(scan, root) !== undefined })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      await refuse(root, id, action, error, !signalled)
    }
  }

  async function play(root: string, id: OperationId) {
    let spawned = false
    try {
      const record = state().saved.tabs.find((tab) => tab.root === root)?.lifecycle
      if (record?.kind !== 'paused') throw new Error('This project has no saved way to start.')
      if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`The project folder is missing: ${root}`)
      await verifyLauncher(record.launcher)
      if (runs(await freshScan(), root)) return void dispatch({ type: 'lifecycle-started', root, id })
      dispatch({ type: 'lifecycle-confirmed', root, id, launcher: null })
      mkdirSync(logFolder, { recursive: true })
      const stderrPath = join(logFolder, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.log`)
      const child = await startSupervisor(record.launcher, root, stderrPath, log)
      spawned = true
      let ended: string | null = null
      child.once('exit', (code, signal) => (ended = `Ultimate exited with ${signal ?? `code ${code}`}.`))
      child.once('error', (error) => (ended = reason(error)))
      log(`play ${root}: started supervisor ${child.pid}`)
      const timer = late(root, id, START_LATE_MS, 'Ultimate has not started after 30 seconds. Hub is still waiting.')
      try {
        for (;;) {
          // An exit that came before this scan started, with the project still not running, is a failed start.
          // If the project runs, another start won the race, and Ultimate's lock refused this one.
          const endedBefore = ended
          const instance = runs(await freshScan(), root)
          if (instance && (await statusAnswers(instance.port))) return void dispatch({ type: 'lifecycle-started', root, id })
          if (endedBefore && !instance) throw new Error(lastLine(stderrPath) ?? endedBefore)
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      await refuse(root, id, 'play', error, !spawned)
    }
  }

  function act(root: string, action: LifecycleAction) {
    const id = randomUUID() as OperationId
    dispatch({ type: 'lifecycle', root, id, action })
    if (!isCurrent(root, id)) return
    void (action === 'play' ? play(root, id) : stop(root, id, action))
  }

  /** The launcher of a running Ultimate, else of a paused tab. Hub has no other way to know where Ultimate is installed. */
  async function anyLauncher(): Promise<Launcher | null> {
    for (const { root } of state().instances) {
      try {
        return await readLauncher(await verifySupervisor(root, log))
      } catch (error) {
        log(`add: no launcher from ${root}: ${reason(error)}`)
      }
    }
    for (const { lifecycle } of state().saved.tabs) {
      if (lifecycle?.kind !== 'paused') continue
      const found = await verifyLauncher(lifecycle.launcher).then(() => true, () => false)
      if (found) return lifecycle.launcher
    }
    return null
  }

  /**
   * The user chose `chosen` in the folder picker, which allows a start of the project found there. A start in a folder
   * where Ultimate has not run also needs a yes to the question.
   */
  async function add(chosen: string) {
    let found: { root: string; ran: boolean }
    try {
      found = await findProject(chosen)
    } catch (error) {
      log(`add ${chosen}: ${reason(error)}`)
      return void ask({ icon: 'warning', title: 'Hub could not open this folder', text: reason(error), path: chosen, action: null })
    }
    const { root, ran } = found
    const known = state().saved.tabs.find((tab) => tab.root === root)
    const ready = portOf(state(), root) !== null || root in state().operations || known?.lifecycle != null
    const launcher = ready ? null : await anyLauncher()
    if (!ready && launcher === null) return void ask({ icon: 'warning', title: 'Hub could not find Ultimate on this Mac', text: NO_LAUNCHER, path: root, action: null })
    if (!ran && !(await ask({ icon: 'play', title: 'No Ultimate in this folder', text: START_NEW, path: root, action: 'Start Ultimate' }))) return
    if (!dispatch({ type: 'add', root, launcher }))
      return void ask({ icon: 'warning', title: `Hub could not add ${labelOf(root)}`, text: 'Hub could not save tabs.json, so it did not start the server.', path: root, action: null })
    log(`add ${root}`)
    const tab = state().saved.tabs.find((candidate) => candidate.root === root)
    if (tab?.lifecycle?.kind === 'paused' && portOf(state(), root) === null) act(root, 'play')
  }

  return { act, add }
}

function lastLine(path: string): string | null {
  try {
    const line = readFileSync(path, 'utf8').trim().split('\n').at(-1)?.trim()
    return line ? line.slice(0, 300) : null
  } catch {
    return null
  }
}
