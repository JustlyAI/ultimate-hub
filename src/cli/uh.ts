import { basename, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type AssistantMessage,
  type Conversation,
  type OpenQuestion,
  UltimateError,
  createConversation,
  createScanner,
  readAssistantMessages,
  readLive,
  readStatus,
  submit,
} from '../main/ultimate.ts'
import { KeyReused, UnknownOutcome, once } from './ledger.ts'

// The contract is `docs/cli-contract.md`. Change both together.

export type ErrorCode = 'usage' | 'not_running' | 'not_found' | 'unreachable' | 'protocol' | 'unknown_outcome' | 'internal'
export type Output = ({ ok: true } & Record<string, unknown>) | { ok: false; error: { code: ErrorCode; message: string } }
export type Turn = { state: 'working' | 'idle' | 'question' | 'failed'; answer: string | null }

const DEFAULT_WAIT_S = 600
const POLL_MS = 1000

class Failure extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * A question counts only when it is newer than the conversation's newest input. Ultimate keeps a question open after
 * a typed reply, and `uh` has no other way to answer, so an older question would hold the state at `question`.
 */
export function turnOf(conversation: Conversation, questions: OpenQuestion[], messages: AssistantMessage[]): Turn {
  const newest = messages.at(0)
  const answer = messages.find((message) => message.text !== null)?.text ?? null
  if (conversation.busy) return { state: 'working', answer }
  const question = questions.findLast((asked) => asked.conversation === conversation.id && asked.at > (conversation.inputAt ?? 0))
  if (question) return { state: 'question', answer: question.text }
  if (newest?.error) return { state: 'failed', answer: newest.text ?? newest.error }
  return { state: 'idle', answer }
}

type Options = { key?: string; title?: string; timeout?: string }
type Input = { port: number; root: string; conversation: number; options: Options; stdin: () => Promise<string> }
type Spec = { positionals: number; options: (keyof Options)[]; run(input: Input): Promise<Record<string, unknown>> }

const log = (line: string) => process.stderr.write(`${line}\n`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function running() {
  const { instances, fresh } = await createScanner(log)()
  if (!fresh) throw new Failure('internal', 'lsof failed, so uh cannot tell which Ultimates run.')
  return instances
}

async function readTurn(port: number, id: number): Promise<Turn> {
  const [live, messages] = await Promise.all([readLive(port, true), readAssistantMessages(port, id)])
  const conversation = live.conversations.find((candidate) => candidate.id === id)
  if (!conversation) throw new Failure('not_found', 'Unknown conversation')
  return turnOf(conversation, live.questions, messages)
}

function keyOf({ key }: Options): string {
  if (!key) throw new Failure('usage', 'This command needs --key.')
  return key
}

const commands: Record<string, Spec> = {
  list: {
    positionals: 0,
    options: [],
    run: async () => ({ ultimates: (await running()).map(({ root, port }) => ({ root, name: basename(root), port })) }),
  },
  status: {
    positionals: 1,
    options: [],
    run: async ({ port }) => {
      const { busy, questions, failures } = await readStatus(port)
      return { busy, questions, failures }
    },
  },
  conversations: {
    positionals: 1,
    options: [],
    run: async ({ port }) => ({
      conversations: (await readLive(port, false)).conversations.map(({ id, title, busy }) => ({ id, title, busy })),
    }),
  },
  new: {
    positionals: 1,
    options: ['key', 'title'],
    run: async ({ port, root, options }) => ({
      conversation: await once(keyOf(options), JSON.stringify(['new', root, options.title ?? null]), () => createConversation(port, options.title)),
    }),
  },
  send: {
    positionals: 2,
    options: ['key'],
    run: async ({ port, root, conversation, options, stdin }) => {
      const key = keyOf(options)
      const prompt = await stdin()
      if (!prompt.trim()) throw new Failure('usage', 'Give the prompt text on stdin.')
      return { submission: await once(key, JSON.stringify(['send', root, conversation]), () => submit(port, conversation, prompt)) }
    },
  },
  read: {
    positionals: 2,
    options: [],
    run: async ({ port, conversation }) => readTurn(port, conversation),
  },
  wait: {
    positionals: 2,
    options: ['timeout'],
    run: async ({ port, conversation, options }) => {
      const seconds = options.timeout === undefined ? DEFAULT_WAIT_S : Number(options.timeout)
      if (options.timeout === '' || !Number.isFinite(seconds) || seconds < 0) throw new Failure('usage', '--timeout is a number of seconds.')
      const deadline = performance.now() + seconds * 1000
      for (;;) {
        const turn = await readTurn(port, conversation)
        const left = deadline - performance.now()
        if (turn.state !== 'working' || left <= 0) return turn
        await sleep(Math.min(POLL_MS, left))
      }
    },
  },
}

const USAGE = 'uh list | status <ultimate> | conversations <ultimate> | new <ultimate> --key K [--title T] | send <ultimate> <conversation> --key K | read <ultimate> <conversation> | wait <ultimate> <conversation> [--timeout S]'

async function execute(argv: string[], stdin: () => Promise<string>): Promise<Record<string, unknown>> {
  let positionals: string[]
  let options: Options
  try {
    ;({ positionals, values: options } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { key: { type: 'string' }, title: { type: 'string' }, timeout: { type: 'string' } },
    }))
  } catch (error) {
    throw new Failure('usage', (error as Error).message)
  }
  const [name, root, id, ...extra] = positionals
  const spec = Object.hasOwn(commands, name ?? '') ? commands[name] : undefined
  const given = Object.keys(options) as (keyof Options)[]
  if (!spec || extra.length > 0 || positionals.length - 1 !== spec.positionals || given.some((option) => !spec.options.includes(option)))
    throw new Failure('usage', `Usage: ${USAGE}`)
  if (spec.positionals === 0) return spec.run({ port: 0, root: '', conversation: 0, options, stdin })
  if (!isAbsolute(root)) throw new Failure('usage', '<ultimate> is the absolute path of the project root, as `uh list` prints it.')
  if (spec.positionals === 2 && !/^[1-9]\d{0,14}$/.test(id)) throw new Failure('usage', '<conversation> is a conversation id, a positive integer.')
  const instance = (await running()).find((candidate) => candidate.root === root)
  if (!instance) throw new Failure('not_running', `No running Ultimate has the root ${root}.`)
  return spec.run({ port: instance.port, root, conversation: Number(id), options, stdin })
}

/** Never throws. Each error becomes the failure shape of the contract. */
export async function run(argv: string[], stdin: () => Promise<string>): Promise<Output> {
  try {
    return { ok: true, ...(await execute(argv, stdin)) }
  } catch (error) {
    const code: ErrorCode =
      error instanceof Failure || error instanceof UltimateError
        ? error.code
        : error instanceof UnknownOutcome
          ? 'unknown_outcome'
          : error instanceof KeyReused
            ? 'usage'
            : 'internal'
    return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
  }
}
