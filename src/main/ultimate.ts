import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, openSync, realpathSync } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Command, Instance, InstanceStatus, Launcher } from '../shared/tabs'

// All knowledge of Ultimate's files lives here, because their format can change without notice.

const LSOF_TIMEOUT_MS = 5000
const FAILED_SCANS_BEFORE_EMPTY = 3
const STATUS_INTERVAL_MS = 5000
const API_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 30000

type Log = (line: string) => void
type Listeners = Map<number, Set<number>>
type Lock = { pid: number; port: number; project: string }

function parseLock(text: string): Lock {
  const { pid, port, project } = JSON.parse(text)
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('lock has no valid pid')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('lock has no valid port')
  if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('lock has no absolute project')
  return { pid, port, project }
}

/** A missing lock is normal. A bad lock is logged. Both mean that the project is not running. */
async function readLock(path: string, log: Log): Promise<Lock | null> {
  try {
    return parseLock(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`${path}: ${String(error)}`)
    return null
  }
}

/** The ports each process listens on. Only a process that owns the socket can prove that a lock is true. */
export function parseListeners(output: string): Listeners {
  const listeners: Listeners = new Map()
  let ports: Set<number> | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      ports = new Set()
      listeners.set(Number(line.slice(1)), ports)
    } else if (line.startsWith('n')) {
      ports?.add(Number(line.slice(line.lastIndexOf(':') + 1)))
    }
  }
  return listeners
}

/** null means that lsof failed, which says nothing about what is running. */
function readListeners(log: Log): Promise<Listeners | null> {
  return new Promise((resolve) => {
    // An absolute path, because an app opened from Finder does not get the shell's PATH.
    execFile(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'],
      { timeout: LSOF_TIMEOUT_MS },
      (error, stdout, stderr) => {
        // lsof exits 1, with nothing on stderr, when no process listens.
        if (error && (error.code !== 1 || stderr)) {
          log(`lsof: ${String(error)}`)
          resolve(null)
        } else resolve(parseListeners(stdout))
      },
    )
  })
}

const projectsFolder = () => join(homedir(), '.ultimate', 'projects')

/** Ultimate keeps a folder for each project it has run in, named from the project's real path. It stays after a stop. */
const projectHome = (root: string) => join(projectsFolder(), `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`)

const hasRun = async (root: string) => (await stat(projectHome(root)).catch(() => null))?.isDirectory() === true

/**
 * The real path of the chosen folder if Ultimate has run in it, else of the first folder in it, by name, where Ultimate
 * has run. If neither, the chosen folder with `ran` false.
 */
export async function findProject(chosen: string): Promise<{ root: string; ran: boolean }> {
  const root = await realpath(chosen)
  if (await hasRun(root)) return { root, ran: true }
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(({ name }) => name)
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const child = await realpath(join(root, name)).catch(() => null)
    if (child && (await hasRun(child))) return { root: child, ran: true }
  }
  return { root, ran: false }
}

async function readLocks(log: Log): Promise<Lock[]> {
  const directory = projectsFolder()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const locks = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(({ name }) => readLock(join(directory, name, 'ultimate.lock'), log)),
  )
  return locks.filter((lock) => lock !== null)
}

async function provenInstances(listeners: Listeners, log: Log): Promise<Instance[]> {
  const instances = new Map<string, Instance>()
  for (const lock of await readLocks(log))
    // While a project starts, its lock can hold a port that another project owns.
    if (listeners.get(lock.pid)?.has(lock.port)) instances.set(lock.project, { root: lock.project, port: lock.port })
  return [...instances.values()].sort((a, b) => a.root.localeCompare(b.root))
}

/** `fresh` is false when lsof failed. Such a scan cannot prove that a project stopped. */
export type Scan = { instances: Instance[]; fresh: boolean }

export function createScanner(log: Log) {
  let last: Instance[] = []
  let failures = 0
  return async function scan(): Promise<Scan> {
    const read = await readListeners(log)
    const fresh = read !== null
    const listeners = read ?? new Map()
    if (fresh) failures = 0
    else {
      // One failure must not close every loaded page. A list that stays frozen can show the wrong project.
      failures++
      if (failures < FAILED_SCANS_BEFORE_EMPTY) return { instances: last, fresh }
    }
    last = await provenInstances(listeners, log)
    return { instances: last, fresh }
  }
}

function countOf(value: unknown, field: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`status has no valid ${field}`)
  return value as number
}

/** A field that another extension owns is absent while that extension is off. A wrong type means a new format. */
export function parseStatus(text: string): InstanceStatus {
  const { result } = JSON.parse(text)
  if (typeof result !== 'object' || result === null) throw new Error('status has no result')
  const { questions, failures, busy } = result
  if (questions !== undefined && (typeof questions !== 'object' || questions === null)) throw new Error('status has no valid questions')
  if (failures !== undefined && !Array.isArray(failures)) throw new Error('status has no valid failures')
  return {
    questions: countOf(questions?.count, 'questions'),
    failures: failures?.length ?? 0,
    busy: countOf(busy, 'busy'),
  }
}

export type UltimateErrorCode = 'unreachable' | 'not_found' | 'protocol'

/** `sent` is false only when Ultimate certainly did not do the request. A caller must not repeat a request that was sent. */
export class UltimateError extends Error {
  readonly code: UltimateErrorCode
  readonly sent: boolean
  constructor(code: UltimateErrorCode, message: string, sent: boolean) {
    super(message)
    this.code = code
    this.sent = sent
  }
}

// Ultimate admits a request without a proxy header only on a loopback address.
const originOf = (port: number) => `http://127.0.0.1:${port}`

type Call = { body?: object; origin?: boolean; timeout?: number }

async function call(port: number, path: string, { body, origin, timeout = API_TIMEOUT_MS }: Call = {}): Promise<string> {
  let response: Response
  let text: string
  try {
    response = await fetch(originOf(port) + path, {
      method: body ? 'POST' : 'GET',
      // Ultimate refuses an action with no Origin, and its status README tells dashboards to send their instance's own.
      headers: origin ? { Origin: originOf(port) } : {},
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      // Ultimate is on loopback. A redirect would send the body to another host.
      redirect: 'error',
    })
    text = await response.text()
  } catch (error) {
    const cause = (error as { cause?: { syscall?: string } }).cause
    // A failed connect sent nothing. Any later failure can come after Ultimate got the request.
    throw new UltimateError('unreachable', `${path}: ${String(cause ?? error)}`, cause?.syscall !== 'connect')
  }
  if (response.ok) return text
  if (response.status === 404 && text.includes('Unknown conversation')) throw new UltimateError('not_found', 'Unknown conversation', false)
  // Ultimate answers 4xx before it acts. A 5xx can come after a part of the work.
  throw new UltimateError('protocol', `${path} answered ${response.status}`, response.status >= 500)
}

/** A 2xx answer that does not parse is a new format. The request was done. */
function parsed<T>(what: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new UltimateError('protocol', `${what}: ${String(error)}`, true)
  }
}

export async function readStatus(port: number, since?: number): Promise<InstanceStatus> {
  const path = '/api/extensions/status/actions/status'
  const text = await call(port, path, { body: { args: since === undefined ? {} : { since } }, origin: true })
  return parsed('status', () => parseStatus(text))
}

export type Conversation = { id: number; title: string | null; busy: boolean; inputAt: number | null }
/** A message to the user that the user has not answered or dismissed. */
export type OpenQuestion = { conversation: number; at: number; text: string }
/** `error` is set when the run of this message failed. */
export type AssistantMessage = { text: string | null; error: string | null }
export type Live = { conversations: Conversation[]; questions: OpenQuestion[] }

const idOf = (value: unknown, what: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${what} has no valid id`)
  return value as number
}

/**
 * `busy` comes from the task graph with Ultimate's own rule. The `busy` field of a summary can be 100 ms older than
 * the graph, which is long enough to show a conversation as idle directly after a submit.
 */
export function parseConversations(summaries: unknown, graph: unknown): Conversation[] {
  if (!Array.isArray(summaries)) throw new Error('conversations is not a list')
  const tasks = (graph as { tasks?: unknown } | null)?.tasks
  if (typeof tasks !== 'object' || tasks === null) throw new Error('tasks has no task table')
  const busy = new Set<unknown>()
  for (const task of Object.values(tasks)) if (!task?.background) busy.add(task?.conversationId)
  return summaries.map((summary) => {
    const { title, inputAt } = summary ?? {}
    const id = idOf(summary?.id, 'conversation')
    if (title !== undefined && typeof title !== 'string') throw new Error('conversation has no valid title')
    if (inputAt !== undefined && typeof inputAt !== 'number') throw new Error('conversation has no valid inputAt')
    return { id, title: title ?? null, busy: busy.has(id), inputAt: inputAt ?? null }
  })
}

/** Ultimate's `openQuestion` rule from its `lib/message-state.ts`, on its `board` document. */
export function parseOpenQuestions(board: unknown): OpenQuestion[] {
  const messages = (board as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) throw new Error('board has no messages')
  return messages
    .filter((message) => message?.to === 'user' && message.reply === true && message.state === 'delivered' && typeof message.from === 'number')
    .map(({ from, at, text }) => {
      if (typeof at !== 'number' || typeof text !== 'string') throw new Error('question has no valid time or text')
      return { conversation: from, at, text }
    })
}

/** One page of history, newest first. `before` is absent on the last page. */
export function parseHistory(text: string): { messages: AssistantMessage[]; before?: number } {
  const { entries, before } = JSON.parse(text)
  if (!Array.isArray(entries)) throw new Error('history has no entries')
  if (before !== undefined && !Number.isSafeInteger(before)) throw new Error('history has no valid cursor')
  const messages = entries
    .filter((entry) => entry?.kind === 'pi.assistant')
    .map((entry): AssistantMessage => {
      const message = entry.model?.[0]
      if (!Array.isArray(message?.content)) throw new Error('assistant entry has no content')
      const said = message.content
        .filter((block: { type?: unknown }) => block?.type === 'text')
        .map((block: { text?: unknown }) => {
          if (typeof block.text !== 'string') throw new Error('text block has no text')
          return block.text
        })
        .join('')
      const failed = message.stopReason === 'error'
      return { text: said || null, error: failed ? (typeof message.errorMessage === 'string' ? message.errorMessage : 'The run failed.') : null }
    })
  return { messages, before }
}

/** One server-sent event. An event of a subscription has the subscription's id as its first data line. */
export function parseEvent(block: string): { name: string; data: unknown[] } | null {
  const lines = block.split('\n')
  const name = lines.find((line) => line.startsWith('event: '))?.slice(7)
  if (!name) return null
  return { name, data: lines.filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))) }
}

const BOARD_SUBSCRIPTION = 1

/**
 * Ultimate gives its conversation list, its task graph, and its open questions only on the event stream that a page
 * uses. This opens the stream, reads the first of each, and closes it. Open questions cost one subscription, to the
 * `board` document.
 */
export async function readLive(port: number, withQuestions: boolean): Promise<Live> {
  const path = '/api/events'
  const stop = new AbortController()
  const found: { conversations?: unknown; tasks?: unknown; board?: unknown } = {}
  const complete = () => 'conversations' in found && 'tasks' in found && (!withQuestions || 'board' in found)
  try {
    const response = await fetch(originOf(port) + path, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(API_TIMEOUT_MS)]), redirect: 'error' })
    if (!response.ok || !response.body) throw new UltimateError('protocol', `${path} answered ${response.status}`, false)
    let buffer = ''
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const event = parsed('event', () => parseEvent(buffer.slice(0, end)))
        buffer = buffer.slice(end + 2)
        if (event?.name === 'conversations' || event?.name === 'tasks') found[event.name] = event.data[0]
        else if (event?.name === 'doc' && event.data[0] === BOARD_SUBSCRIPTION) found.board = (event.data[1] as { value?: unknown } | null)?.value
        else if (event?.name === 'stream' && withQuestions) {
          const id = (event.data[0] as { id?: unknown } | null)?.id
          if (typeof id !== 'string') throw new UltimateError('protocol', 'stream has no id', false)
          await call(port, `${path}/${id}/${BOARD_SUBSCRIPTION}`, { body: { docs: ['board'], view: false } })
        }
        if (complete()) break
      }
      if (complete()) break
    }
  } catch (error) {
    if (error instanceof UltimateError) throw error
    const cause = (error as { cause?: unknown }).cause
    throw new UltimateError('unreachable', `${path}: ${String(cause ?? error)}`, false)
  } finally {
    stop.abort()
  }
  if (!complete()) throw new UltimateError('protocol', `${path} ended before the first state`, false)
  return parsed('events', () => ({
    conversations: parseConversations(found.conversations, found.tasks),
    questions: withQuestions ? parseOpenQuestions(found.board) : [],
  }))
}

/** Newest first, down to the newest message that has text. Throws `not_found` for an unknown conversation. */
export async function readAssistantMessages(port: number, conversation: number): Promise<AssistantMessage[]> {
  const messages: AssistantMessage[] = []
  for (let before: number | undefined = Number.MAX_SAFE_INTEGER; before !== undefined; ) {
    const text = await call(port, `/api/conversations/${conversation}/history?before=${before}`)
    const page = parsed('history', () => parseHistory(text))
    const answer = page.messages.findIndex((message) => message.text !== null)
    if (answer !== -1) return [...messages, ...page.messages.slice(0, answer + 1)]
    messages.push(...page.messages)
    before = page.before
  }
  return messages
}

export async function createConversation(port: number, title: string | undefined): Promise<number> {
  const text = await call(port, '/api/conversations', { body: { title }, timeout: WRITE_TIMEOUT_MS })
  return parsed('new conversation', () => idOf(JSON.parse(text).id, 'new conversation'))
}

/** Ultimate has no idempotency key for a submit. The caller must make sure that it sends each prompt once. */
export async function submit(port: number, conversation: number, prompt: string): Promise<number> {
  const text = await call(port, `/api/conversations/${conversation}/submit`, { body: { text: prompt }, timeout: WRITE_TIMEOUT_MS })
  return parsed('submission', () => idOf(JSON.parse(text).submissionId, 'submission'))
}

/** Asks each instance on its own clock, and never waits, so that a slow Ultimate cannot hold a scan. */
export function createStatusPoller(log: Log, answer: (command: Extract<Command, { type: 'status' }>) => void) {
  const asked = new Map<string, { port: number; at: number }>()
  return function poll(instances: Instance[], sinceOf: (root: string) => number | undefined) {
    const now = performance.now()
    const running = new Set(instances.map(({ root }) => root))
    for (const root of asked.keys()) if (!running.has(root)) asked.delete(root)
    for (const { root, port } of instances) {
      const last = asked.get(root)
      if (last?.port === port && now - last.at < STATUS_INTERVAL_MS) continue
      asked.set(root, { port, at: now })
      const since = sinceOf(root)
      readStatus(port, since)
        .then((status) => answer({ type: 'status', root, port, since, status }))
        .catch((error) => log(`status ${root}: ${String(error)}`))
    }
  }
}

export const statusAnswers = (port: number): Promise<boolean> => readStatus(port, undefined).then(() => true, () => false)

const PS = '/bin/ps'
const LSOF = '/usr/sbin/lsof'
const LOGIN_SHELL_TIMEOUT_MS = 5000

/** One supervisor, proven by its lock, its socket, its user, and its start time. Never saved. */
export type Supervisor = { pid: number; start: string; port: number }

type Ran = { stdout: string; error: (Error & { code?: unknown }) | null }

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: LSOF_TIMEOUT_MS, env }, (error, stdout) => resolve({ stdout, error }))
  })
}

/** lsof and ps exit 1 with no output when nothing matches. Any other failure says nothing about the process. */
async function query(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, error } = await run(file, args, env)
  if (error && !(error.code === 1 && stdout.trim() === '')) throw new Error(`Hub could not check the process (${file.split('/').pop()} failed).`)
  return stdout
}

/** null when the process is gone. `lstart` has a resolution of one second, the same that Ultimate uses for its storage lock. */
async function processOf(pid: number): Promise<{ uid: number; start: string } | null> {
  const output = (await query(PS, ['-o', 'uid=,lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' })).trim()
  if (output === '') return null
  const [uid, ...start] = output.split(/\s+/)
  return { uid: Number(uid), start: start.join(' ') }
}

async function fdPaths(pid: number, fd: string): Promise<string[]> {
  const output = await query(LSOF, ['-a', '-p', String(pid), '-d', fd, '-Fn'])
  return output.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1))
}

export async function verifySupervisor(root: string, log: Log): Promise<Supervisor> {
  const lock = (await readLocks(log)).find(({ project }) => project === root)
  if (!lock) throw new Error('Ultimate is not running for this project.')
  const listening = parseListeners(await query(LSOF, ['-nP', '-a', '-p', String(lock.pid), '-iTCP', '-sTCP:LISTEN', '-Fpn']))
  if (!listening.get(lock.pid)?.has(lock.port)) throw new Error('The process in the lock does not own its port.')
  const found = await processOf(lock.pid)
  if (!found) throw new Error('The process in the lock is gone.')
  if (found.uid !== process.getuid!()) throw new Error('The process belongs to another user.')
  return { pid: lock.pid, start: found.start, port: lock.port }
}

/**
 * The entry is the text that ends in `bin/ultimate.ts`. A relative path, as `pnpm start` gives (`node bin/ultimate.ts`),
 * resolves against the working directory, and the first split at a space that exists on disk handles paths with spaces.
 */
export function entryOf(args: string, cwd: string, exists: (path: string) => boolean): string | null {
  const match = /[ /]bin\/ultimate\.ts/.exec(args)
  if (!match) return null
  const end = match.index + match[0].length
  for (let at = args.indexOf(' '); at !== -1 && at < end; at = args.indexOf(' ', at + 1)) {
    const candidate = resolve(cwd, args.slice(at + 1, end))
    if (exists(candidate)) return candidate
  }
  return null
}

export async function verifyLauncher(launcher: Launcher): Promise<void> {
  try {
    await access(launcher.node, constants.X_OK)
  } catch {
    throw new Error(`Node is not available at ${launcher.node}.`)
  }
  try {
    const { name } = JSON.parse(await readFile(join(launcher.entry, '../../package.json'), 'utf8'))
    if (name !== 'ultimate' || !(await stat(launcher.entry)).isFile()) throw new Error()
  } catch {
    throw new Error(`Ultimate is not available at ${launcher.entry}.`)
  }
}

/** The Node binary that runs the supervisor, and its `bin/ultimate.ts`. `ps -o comm=` gives only `node`. */
export async function readLauncher(target: Supervisor): Promise<Launcher> {
  const [node] = await fdPaths(target.pid, 'txt')
  const [cwd] = await fdPaths(target.pid, 'cwd')
  const args = (await query(PS, ['-o', 'args=', '-p', String(target.pid)])).trim()
  const entry = node && cwd ? entryOf(args, cwd, existsSync) : null
  if (!node || !entry) throw new Error('Hub cannot find how this Ultimate was started, so it could not start it again.')
  const launcher = { node: realpathSync(node), entry: realpathSync(entry) }
  await verifyLauncher(launcher)
  return launcher
}

export async function signalSupervisor(target: Supervisor): Promise<void> {
  const found = await processOf(target.pid)
  if (found?.start !== target.start || found.uid !== process.getuid!()) throw new Error('The process changed, so Hub did not stop it.')
  // macOS has no way to signal a verified process atomically. The PID can be reused between the ps read above and this
  // signal, which was 1.2 ms apart (median of 20) on a development Mac. The design accepts this limit.
  process.kill(target.pid, 'SIGTERM')
}

/** True once the PID no longer has the same start time. A failed ps proves nothing. */
export async function exited(target: Supervisor): Promise<boolean> {
  return (await processOf(target.pid))?.start !== target.start
}

export function launchPath(loginPath: string | null, nodeFolder: string, hubPath: string | undefined): string {
  if (loginPath === null) return [nodeFolder, hubPath].filter(Boolean).join(':')
  return loginPath.split(':').includes(nodeFolder) ? loginPath : `${loginPath}:${nodeFolder}`
}

let loginPath: Promise<string | null> | undefined

/** Runs the login shell once, only to read its PATH for the Ultimates that the app starts. An app opened from Finder has `/usr/bin:/bin:/usr/sbin:/sbin`. */
function readLoginPath(log: Log): Promise<string | null> {
  loginPath ??= new Promise((done) => {
    const shell = process.env.SHELL || userInfo().shell
    if (!shell) {
      log('login shell PATH: no shell, so Hub uses its own PATH')
      return done(null)
    }
    execFile(shell, ['-l', '-c', 'printf %s "$PATH"'], { timeout: LOGIN_SHELL_TIMEOUT_MS }, (error, stdout) => {
      const path = stdout.split('\n').at(-1)!.trim()
      if (error || !path.startsWith('/')) {
        log(`login shell PATH: ${shell} ${error ? String(error).split('\n')[0] : 'gave no absolute PATH'}, so Hub uses its own PATH`)
        done(null)
      } else done(path)
    })
  })
  return loginPath
}

/** Detached, with no pipe to Hub, so that it outlives Hub. Its stderr goes to a file, never a pipe. */
export async function startSupervisor(launcher: Launcher, root: string, stderrPath: string, log: Log): Promise<ChildProcess> {
  const { ULTIMATE_HOME: _home, ULTIMATE_PORT: _port, ...env } = process.env
  env.PATH = launchPath(await readLoginPath(log), dirname(launcher.node), process.env.PATH)
  const stderr = openSync(stderrPath, 'w')
  try {
    const child = spawn(launcher.node, [launcher.entry, root, '--no-open'], { cwd: root, detached: true, stdio: ['ignore', 'ignore', stderr], env })
    child.unref()
    return child
  } finally {
    closeSync(stderr)
  }
}
