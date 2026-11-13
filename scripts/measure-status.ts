// The cost of the status call and what a poll misses, with real Ultimates and the packaged app.
// node scripts/measure-status.ts [label=path/to/app/executable ...]. With no argument, it measures this checkout's build.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { median, p95 } from '../test/e2e/scale.ts'
import { BareHub } from '../test/support/bare.ts'
import { cleanUp, makeProject, processTree, sleep, startScriptedModel, startUltimate, tempDir, until, type RealUltimate } from '../test/support/fixtures.ts'
import { APP } from '../test/support/hub.ts'
import { EVIDENCE } from '../test/support/report.ts'

const COUNT = Number(process.env.STATUS_INSTANCES ?? 30)
const REPEATS = Number(process.env.STATUS_REPEATS ?? 3)
const WINDOW_MS = 60000
const SPREAD_MS = 30000
const TURN_MS = (process.env.STATUS_TURNS ?? '3000,15000,60000').split(',').map(Number)
const AFTER_MS = 36000
const STATUS_PATH = '/api/extensions/status/actions/status'

const arms = process.argv.slice(2).map((argument) => argument.split('=') as [string, string])
if (arms.length === 0) arms.push(['built', APP])

type Instance = { root: string; port: number; ultimate: RealUltimate; agent: number }

async function act(port: number, path: string, body: object) {
  const origin = `http://127.0.0.1:${port}`
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} on ${port} answered ${response.status}`)
  return response.json() as Promise<{ result: { busy: number } & number }>
}

/** Seconds of CPU that the processes have used, from ps, which has a resolution of 10 ms. */
function cpuSeconds(pids: number[]): number {
  return execFileSync('/bin/ps', ['-o', 'time=', '-p', pids.join(',')], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .reduce((sum, line) => sum + line.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0), 0)
}

const spread = (values: number[]) => ({ median: Number(median(values).toFixed(2)), min: Number(Math.min(...values).toFixed(2)), max: Number(Math.max(...values).toFixed(2)) })

async function launch(app: string, home: string, count: number) {
  const hub = await BareHub.launch(home, tempDir('data'), app)
  await until('every tab', async () => (await hub.topRows()).length === count, 30000)
  await hub.main(() => {
    const real = globalThis.fetch
    const calls: { at: number; ms: number; status: number }[] = []
    ;(globalThis as unknown as { statusCalls: typeof calls }).statusCalls = calls
    globalThis.fetch = async (url, init) => {
      const at = Date.now()
      const started = performance.now()
      const response = await real(url, init)
      calls.push({ at, ms: performance.now() - started, status: response.status })
      return response
    }
  })
  return hub
}

const readCalls = (hub: BareHub) => hub.main(() => (globalThis as unknown as { statusCalls: { at: number; ms: number; status: number }[] }).statusCalls.splice(0))

async function measureCost(home: string, instances: Instance[]) {
  const ultimatePids = instances.flatMap(({ ultimate }) => processTree(ultimate.child.pid!))
  const results: Record<string, unknown[]> = Object.fromEntries(arms.map(([label]) => [label, []]))
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const [label, app] of arms) {
      const hub = await launch(app, home, instances.length)
      await sleep(5000)
      await readCalls(hub)
      const before = { main: await hub.main(() => process.cpuUsage()), tree: cpuSeconds(hub.tree()), ultimates: cpuSeconds(ultimatePids) }
      await sleep(WINDOW_MS)
      const main = await hub.main((_electron, previous) => process.cpuUsage(previous), before.main)
      const tree = cpuSeconds(hub.tree()) - before.tree
      const ultimates = cpuSeconds(ultimatePids) - before.ultimates
      const calls = await readCalls(hub)
      await hub.quit()
      const row = {
        calls: calls.length,
        refused: calls.filter(({ status }) => status !== 200).length,
        callMedianMs: calls.length ? Number(median(calls.map(({ ms }) => ms)).toFixed(1)) : null,
        callP95Ms: calls.length ? Number(p95(calls.map(({ ms }) => ms)).toFixed(1)) : null,
        callMaxMs: calls.length ? Number(Math.max(...calls.map(({ ms }) => ms)).toFixed(1)) : null,
        mainCpuSeconds: Number(((main.user + main.system) / 1e6).toFixed(3)),
        hubTreeCpuSeconds: Number(tree.toFixed(2)),
        ultimatesCpuSeconds: Number(ultimates.toFixed(2)),
      }
      results[label].push(row)
      console.log(`cost ${label} repeat ${repeat}: ${JSON.stringify(row)}`)
    }
  }
  return Object.fromEntries(
    Object.entries(results).map(([label, rows]) => {
      const typed = rows as { calls: number; refused: number; callMedianMs: number | null; callP95Ms: number | null; callMaxMs: number | null; mainCpuSeconds: number; hubTreeCpuSeconds: number; ultimatesCpuSeconds: number }[]
      const pick = (key: keyof (typeof typed)[number]) => spread(typed.map((row) => Number(row[key] ?? 0)))
      return [label, { windowSeconds: WINDOW_MS / 1000, repeats: typed.length, instances: COUNT, calls: pick('calls'), refused: pick('refused'), callMedianMs: pick('callMedianMs'), callP95Ms: pick('callP95Ms'), callMaxMs: pick('callMaxMs'), mainCpuSeconds: pick('mainCpuSeconds'), hubTreeCpuSeconds: pick('hubTreeCpuSeconds'), ultimatesCpuSeconds: pick('ultimatesCpuSeconds') }]
    }),
  )
}

/** Each unselected instance runs one turn, at a random time, and the sidebar and a direct read are sampled each second. */
async function measureMisses(home: string, instances: Instance[], [label, app]: [string, string], turnMs: number) {
  const hub = await launch(app, home, instances.length)
  await sleep(3000)
  const selected = (await hub.topRows()).find((tab) => tab.selected)!.root
  const watched = instances.filter(({ root }) => root !== selected)
  const seen = new Map(watched.map(({ root }) => [root, { busyAt: 0, idleAt: 0, workingAt: 0, doneAt: 0 }]))
  let sending = true
  const sends = watched.map(async ({ port, agent }) => {
    await sleep(Math.random() * SPREAD_MS)
    await act(port, `/api/conversations/${agent}/submit`, { text: `timed-${turnMs}` })
  })
  const allSent = Promise.all(sends).then(() => (sending = false))
  let lastBusyAt = Date.now()
  while (sending || Date.now() - lastBusyAt < AFTER_MS) {
    const now = Date.now()
    const answers = await Promise.all(watched.map(({ port }) => act(port, STATUS_PATH, { args: { since: now } }).catch(() => null)))
    const groups = await hub.inShell<Record<string, string>>(`(() => {
      const found = {}
      let group = ''
      for (const element of document.querySelector('#status').children) {
        if (element.classList.contains('status-heading')) group = element.dataset.kind
        else found[element.dataset.root] = group
      }
      return found
    })()`)
    watched.forEach(({ root }, index) => {
      const row = seen.get(root)!
      if ((answers[index]?.result.busy ?? 0) > 0) {
        row.busyAt ||= now
        row.idleAt = 0
        lastBusyAt = now
      } else if (row.busyAt) row.idleAt ||= now
      if (groups[root] === 'working') row.workingAt ||= now
      if (groups[root] === 'done') row.doneAt ||= now
    })
    await sleep(Math.max(0, 1000 - (Date.now() - now)))
  }
  await allSent
  const calls = await readCalls(hub)
  await hub.quit()
  const rows = [...seen.values()]
  const lag = (values: number[]) => (values.length ? { medianS: Number((median(values) / 1000).toFixed(1)), maxS: Number((Math.max(...values) / 1000).toFixed(1)) } : null)
  const result = {
    label,
    turnMs,
    turnsSent: watched.length,
    busySeenInDirectRead: rows.filter(({ busyAt }) => busyAt).length,
    showedWorking: rows.filter(({ workingAt }) => workingAt).length,
    showedDone: rows.filter(({ doneAt }) => doneAt).length,
    workingLag: lag(rows.filter(({ workingAt, busyAt }) => workingAt && busyAt).map(({ workingAt, busyAt }) => workingAt - busyAt)),
    doneLag: lag(rows.filter(({ doneAt, idleAt }) => doneAt && idleAt).map(({ doneAt, idleAt }) => doneAt - idleAt)),
    appCalls: calls.length,
    refused: calls.filter(({ status }) => status !== 200).length,
  }
  console.log(`misses ${JSON.stringify(result)}`)
  return result
}

const home = tempDir('home')
const projects = tempDir('projects')
const model = await startScriptedModel()
const instances: Instance[] = []
mkdirSync(EVIDENCE, { recursive: true })
try {
  const bootStarted = Date.now()
  for (let index = 0; index < COUNT; index++) {
    const root = makeProject(projects, `measure-${String(index).padStart(2, '0')}`)
    const ultimate = startUltimate(home, root, model.agentDir)
    const port = await ultimate.port()
    const { result } = await until(`${root} core`, () => act(port, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } }).catch(() => null), 120000)
    instances.push({ root, port, ultimate, agent: result as unknown as number })
    console.log(`started ${root} on ${port} after ${Date.now() - bootStarted} ms`)
  }
  const cost = await measureCost(home, instances)
  const misses = []
  for (const arm of arms.filter(([label]) => label !== 'no-poll')) for (const turnMs of TURN_MS) misses.push(await measureMisses(home, instances, arm, turnMs))
  const report = { instances: COUNT, machine: `${process.arch} ${execFileSync('/usr/sbin/sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).trim()} cores`, load: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(), cost, misses }
  writeFileSync(join(EVIDENCE, 'status-cost.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const { ultimate } of instances) await ultimate.stop().catch(console.error)
  model.close()
  await cleanUp()
}
