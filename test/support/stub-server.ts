// A stand-in for an Ultimate supervisor. It owns a listening socket on 127.0.0.1 and serves a page that names its project.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const [root, portArgument, mode] = process.argv.slice(2)
const hue = parseInt(createHash('sha256').update(root).digest('hex').slice(0, 4), 16) % 360
let hits = 0

const STATUS_PATH = '/api/extensions/status/actions/status'
const DAY = 24 * 60 * 60_000

type StatusControl = {
  result?: { failures?: { at: number }[] } & Record<string, unknown>
  raw?: string // An answer that is not JSON, sent instead of `result`.
  code?: number
  delayMs?: number
  hang?: 'headers' | 'body'
}
type StatusCall = { at: number; method: string; headers: Record<string, unknown>; args: { since?: number }; closedAfterMs?: number }

let control: StatusControl = mode === 'slow-status' ? { delayMs: 4000 } : {}
const calls: StatusCall[] = []

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', () => resolve(body))
  })

/** The same rules as Ultimate's admit and runAction, so that a call that a real instance refuses is refused here. */
function refusal({ headers }: IncomingMessage): string | null {
  if (headers.origin && headers.origin !== `http://127.0.0.1:${(server.address() as { port: number }).port}`) return 'Forbidden'
  if (headers['sec-fetch-site'] !== 'same-origin' && !headers.origin) return '{"error":"Extension actions require a browser request"}'
  return null
}

/** Answers like Ultimate's status action, including its rule that `since` filters only `failures`. */
async function answerStatus(request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request)
  const at = Date.now()
  const call: StatusCall = { at, method: request.method!, headers: request.headers, args: body ? JSON.parse(body).args : {} }
  calls.push(call)
  response.on('close', () => (call.closedAfterMs = Date.now() - at))
  const refused = refusal(request)
  if (refused) {
    response.writeHead(403)
    return response.end(refused)
  }
  if (control.hang === 'headers') return
  if (control.hang === 'body') {
    response.writeHead(200)
    return response.write('{"result":')
  }
  if (control.delayMs) await new Promise((resolve) => setTimeout(resolve, control.delayMs))
  if (control.code) {
    response.writeHead(control.code)
    return response.end('{"error":"refused by the stub"}')
  }
  if (control.raw !== undefined) return response.end(control.raw)
  const since = call.args.since ?? at - DAY
  const result = control.result ?? { questions: { count: 0 }, busy: 0, failures: [], extensions: [] }
  response.end(
    JSON.stringify({ result: { at, ...result, ...(result.failures ? { failures: result.failures.filter((failure) => failure.at >= since) } : {}) } }),
  )
}

const server = createServer((request, response) => {
  if (mode === 'drop') return request.socket.destroy()
  if (request.url === STATUS_PATH) return void answerStatus(request, response)
  if (request.url === '/status-calls') return response.end(JSON.stringify(calls))
  if (request.url === '/status-control') {
    return void readBody(request).then((body) => {
      control = JSON.parse(body)
      response.end()
    })
  }
  if (request.url === '/hits') return response.end(String(hits))
  if (request.url === '/favicon.ico') return response.end()
  const { pathname, searchParams } = new URL(request.url!, 'http://stub')
  if (pathname === '/redirect') {
    response.writeHead(302, { location: searchParams.get('to')! })
    return response.end()
  }
  if (pathname === '/framed') {
    response.setHeader('content-type', 'text/html')
    return response.end(`<!doctype html><body data-root="${root}"><iframe id="frame" src="${searchParams.get('src')}"></iframe>`)
  }
  hits++
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>stub ${root}</title>
<body style="margin:0;background:hsl(${hue} 70% 40%);color:#fff;font:20px sans-serif" data-root="${root}">
<h1>${root}</h1>
<a id="external" href="https://example.com/plain">plain</a>
<a id="blank" target="_blank" href="https://example.com/blank">blank</a>
<a id="file" target="_blank" href="file:///etc/hosts">file</a>
<a id="same" href="/second">same</a>
<div id="filler">${'<p>row</p>'.repeat(2000)}</div>
<script>
  window.shownAt = 0
  window.keys = []
  document.addEventListener('keydown', (event) => {
    if (['Control', 'Meta', 'Shift'].includes(event.key)) return
    window.keys.push((event.metaKey ? 'Meta+' : '') + (event.ctrlKey ? 'Ctrl+' : '') + event.key)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    requestAnimationFrame(() => requestAnimationFrame(() => { window.shownAt = Date.now() }))
  })
</script>`)
})

server.listen(Number(portArgument), '127.0.0.1', () => {
  const { port } = server.address() as { port: number }
  process.send?.({ port })
})
// ignore-term ignores the first SIGTERM, as a hung shutdown would, so that the cleanup's own SIGTERM still ends it.
let ignored = mode !== 'ignore-term'
process.on('SIGTERM', () => {
  if (ignored) process.exit(0)
  ignored = true
})
