import { execFile, execFileSync, fork, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const cloneArg = process.env.ULTIMATE_CLONE ?? join(homedir(), 'dev/ultimate-test-clone')
// Use the on-disk case: if Vite sees the clone under two cases, it loads two copies of a module and Ultimate's page breaks.
export const CLONE = existsSync(cloneArg) ? realpathSync.native(cloneArg) : cloneArg
const STUB = join(import.meta.dirname, 'stub-server.ts')

const execFileAsync = promisify(execFile)
const started = new Set<ChildProcess>()
const temps: string[] = []

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function tempDir(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `ultimate-hub-${label}-`)))
  temps.push(path)
  return path
}

export async function until<T>(what: string, read: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      last = await read()
      if (last) return last as NonNullable<T>
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. Last: ${String(last)}`)
    await sleep(50)
  }
}

/** A throwaway git repository, as a real project would be. */
export function makeProject(parent: string, name: string): string {
  const root = join(parent, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init')
  return root
}

export const projectHome = (home: string, root: string) =>
  join(home, '.ultimate', 'projects', `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`)

export function writeLock(home: string, root: string, lock: { pid: number; port: number; project?: string }) {
  const folder = projectHome(home, root)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'ultimate.lock'), JSON.stringify({ project: root, ...lock }))
}

export type Stub = { child: ChildProcess; port: number; root: string; stop(signal?: NodeJS.Signals): Promise<void> }

function stopper(child: ChildProcess) {
  return async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill(signal)
      await exited
    }
    started.delete(child)
  }
}

/** A server process with a real lock file, and no project.json, because the app must not need one. */
export async function startStub(home: string, root: string, port = 0, mode = 'page'): Promise<Stub> {
  const child = fork(STUB, [root, String(port), mode], { stdio: 'ignore' })
  started.add(child)
  const [{ port: bound }] = (await once(child, 'message')) as [{ port: number }]
  writeLock(home, root, { pid: child.pid!, port: bound })
  return { child, port: bound, root, stop: stopper(child) }
}

export type RealUltimate = {
  child: ChildProcess
  root: string
  port(): Promise<number>
  stop(): Promise<void>
  crash(): Promise<void>
}

export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'LANG', 'TMPDIR', 'TERM']
  return {
    ...Object.fromEntries(inherited.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
    HOME: home,
    ...extra,
  }
}

/** A real Ultimate from the clone, with a temporary HOME and the scripted model. */
export function startUltimate(
  home: string,
  root: string,
  agentDir: string,
  { port, env = {} }: { port?: number; env?: Record<string, string> } = {},
): RealUltimate {
  const entry = join(CLONE, 'bin/ultimate.ts')
  if (!existsSync(entry)) throw new Error(`no Ultimate clone at ${CLONE}. Clone it there or set ULTIMATE_CLONE.`)
  const args = [entry, root, '--no-open', ...(port ? ['--port', String(port)] : [])]
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: cleanEnv(home, { PI_CODING_AGENT_DIR: agentDir, ...env }),
    stdio: 'ignore',
  })
  started.add(child)
  return {
    child,
    root,
    async stop() {
      const tree = processTree(child.pid!)
      await stopper(child)()
      await until(`${root} and its children to exit`, () => tree.every((pid) => !isAlive(pid)), 20000)
    },
    async crash() {
      const tree = processTree(child.pid!)
      await stopper(child)('SIGKILL')
      await sleep(3000)
      for (const pid of tree.filter(isAlive)) process.kill(pid, 'SIGTERM')
      await until(`${root} children to exit`, () => tree.every((pid) => !isAlive(pid)), 20000)
    },
    port: () => until(`${root} to own a port`, () => ownedPort(home, root, child.pid!)),
  }
}

async function ownedPort(home: string, root: string, pid: number): Promise<number | null> {
  const lock = JSON.parse(readFileSync(join(projectHome(home, root), 'ultimate.lock'), 'utf8'))
  if (lock.pid !== pid) return null
  const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', `-p${pid}`, '-iTCP', '-sTCP:LISTEN', '-Fn']).catch((error) => error)
  return stdout?.includes(`:${lock.port}\n`) ? lock.port : null
}

/** Every TCP port that these processes listen on, from lsof, so a port that answers is not enough. */
export function listeningPorts(pids: number[]): number[] {
  const output = lsof(['-nP', '-a', `-p${pids.join(',')}`, '-iTCP', '-sTCP:LISTEN', '-Fn'])
  return output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => Number(line.slice(line.lastIndexOf(':') + 1)))
}

export function lsof(args: string[]): string {
  try {
    return execFileSync('/usr/sbin/lsof', args, { encoding: 'utf8' })
  } catch (error) {
    if ((error as { status?: number }).status === 1) return (error as { stdout: string }).stdout
    throw error
  }
}

/** The process and all its descendants. */
export function processTree(root: number): number[] {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  const tree = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of rows)
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
  }
  return [...tree]
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The approach of Ultimate's test/e2e/scripted-model.ts: an OpenAI-compatible endpoint in the test process, registered
 * as a provider through a Pi agent directory. This copy sends text in timed pieces, so that a test can watch a stream.
 * Ultimate's MIT notice is in THIRD_PARTY_LICENSES.md.
 */
export async function startScriptedModel(pieceDelayMs = 150) {
  const requests: { lastRole: string; lastText: string; images: number; tools: boolean }[] = []
  let held: (() => void)[] = []
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'scripted-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', async () => {
      const { messages, tools } = JSON.parse(body) as { messages: { role: string; content: unknown }[]; tools?: unknown[] }
      const content = messages.at(-1)!.content
      const parts = Array.isArray(content) ? (content as { type: string; text?: string }[]) : []
      const lastText = typeof content === 'string' ? content : parts.map((part) => part.text ?? '').join('')
      requests.push({
        lastRole: messages.at(-1)!.role,
        lastText,
        images: parts.filter((part) => part.type === 'image_url').length,
        tools: (tools?.length ?? 0) > 0,
      })
      // Ultimate's title and summary requests repeat the text, and have no tools. Only a real turn may act on a word.
      const word = tools?.length && messages.at(-1)!.role === 'user' ? lastText : ''
      if (word.includes('fail-turn')) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ error: { message: 'scripted failure', type: 'invalid_request_error' } }))
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (word.includes('ask-owner')) {
        const args = { to: 'user', text: 'Ship it?', questions: [{ text: 'Ship it?', kind: 'confirm' }] }
        response.write(
          chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'message', arguments: JSON.stringify(args) } }] }),
        )
        response.write(chunk({}, 'tool_calls'))
        return response.end('data: [DONE]\n\n')
      }
      const timed = /timed-(\d+)/.exec(word)
      if (timed) {
        response.write(chunk({ role: 'assistant', content: 'Working. ' }))
        await sleep(Number(timed[1]))
      }
      if (word.includes('hold-turn')) {
        response.write(chunk({ role: 'assistant', content: 'Holding. ' }))
        await new Promise<void>((resolve) => held.push(resolve))
      }
      const pieces = lastText.includes('stream')
        ? Array.from({ length: 20 }, (_, index) => `piece${index} `)
        : lastText.includes('link')
          ? ['Open [the example site](https://example.com/from-model) now.']
          : ['Done.']
      for (const piece of pieces) {
        response.write(chunk({ role: 'assistant', content: piece }))
        await sleep(pieceDelayMs)
      }
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const agentDir = tempDir('agent')
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'scripted',
          models: [{ id: 'scripted-1', input: ['text', 'image'] }],
        },
      },
    }),
  )
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'scripted', defaultModel: 'scripted-1' }))
  const release = () => {
    for (const resolve of held) resolve()
    held = []
  }
  return { agentDir, requests, release, close: () => server.close() }
}

/** Stops only the processes that this run started, and removes only its own temporary folders. */
export async function cleanUp() {
  await Promise.all([...started].map((child) => stopper(child)()))
  for (const path of temps) rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

/** A run's processes name one of its temporary folders, in their arguments or in the HOME they inherit. */
export const namesThisRun = (text: string) => temps.some((path) => text.includes(path))

export const stillRunning = () => [...started].filter((child) => child.exitCode === null && child.signalCode === null)
