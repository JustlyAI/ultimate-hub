// Records toasts and stream status on a real Ultimate from the moment its lock is proven.
// node scripts/measure-startup.ts [runs] [filter], where filter matches a condition such as "fresh hub at-lock".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { BareHub } from '../test/support/bare.ts'
import { cleanEnv, cleanUp, makeProject, projectHome, sleep, startScriptedModel, startUltimate, tempDir, until, type RealUltimate } from '../test/support/fixtures.ts'
import { EVIDENCE } from '../test/support/report.ts'
import { READ_HEALTH, type Health } from '../test/support/settle.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WATCH_MS = 32000
type Engine = { open(url: string): void; read(): Promise<Health | null>; close(): Promise<void> }

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null)

/** The real app with no debugger on its pages. The Hub opens the page by itself when it sees a proven lock. */
async function hubEngine(home: string): Promise<Engine> {
  const hub = await BareHub.launch(home, tempDir('data'))
  return {
    open() {},
    read: () => withTimeout(hub.inShown<Health>(READ_HEALTH), 400),
    close: () => hub.quit(),
  }
}

/** Real Chrome with a temporary profile and HOME, loading the page at the moment the script chooses. */
async function chromeEngine(home: string): Promise<Engine> {
  const context: BrowserContext = await chromium.launchPersistentContext(tempDir('chrome'), {
    executablePath: CHROME,
    headless: false,
    env: cleanEnv(home) as Record<string, string>,
  })
  const page: Page = context.pages()[0] ?? (await context.newPage())
  let opened = false
  return {
    open(url) {
      opened = true
      void page.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {})
    },
    read: async () => (opened ? withTimeout(page.evaluate(READ_HEALTH) as Promise<Health>, 400) : null),
    close: () => context.close(),
  }
}

const logEvents = (home: string, root: string) =>
  readFileSync(join(projectHome(home, root), 'supervisor.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { at: string; source: string; text: string }
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null)

const portWhenProven = (instance: RealUltimate) => instance.port()

async function ready(home: string, root: string) {
  return until('core ready', () => logEvents(home, root).some(({ text }) => /^Ultimate: http/.test(text)), 60000)
}

async function warmUp(home: string, root: string, agentDir: string) {
  const instance = startUltimate(home, root, agentDir)
  await instance.port()
  const hub = await BareHub.launch(home, tempDir('data'))
  await until('a page', () => hub.inShown('!!document.querySelector("#composer-input")'), 60000)
  await sleep(1500)
  await hub.press(['Escape'])
  for (const digit of ['2', '3', '4', '1']) {
    await hub.main(({ webContents }, digit) => webContents.getFocusedWebContents()!.sendInputEvent({ type: 'keyDown', keyCode: digit, modifiers: ['meta'] }), digit)
    await sleep(1500)
  }
  await until('Vite to go quiet', () => {
    const last = logEvents(home, root).filter(({ text }) => /optimized dependencies changed/.test(text)).at(-1)
    return !last || Date.now() - Date.parse(last.at) > 8000
  }, 60000)
  await hub.quit()
  await instance.stop()
}

async function measure(cache: 'fresh' | 'warm', browser: 'hub' | 'chrome', load: 'at-lock' | 'after-ready', agentDir: string) {
  const home = tempDir('home')
  const root = makeProject(tempDir('projects'), 'probe')
  if (cache === 'warm') await warmUp(home, root, agentDir)

  let engine: Engine | undefined
  if (load === 'at-lock') engine = await (browser === 'hub' ? hubEngine(home) : chromeEngine(home))
  const instance = startUltimate(home, root, agentDir)
  const port = await portWhenProven(instance)
  const provenAt = Date.now()
  if (engine) engine.open(`http://127.0.0.1:${port}/`)
  else {
    await ready(home, root)
    engine = await (browser === 'hub' ? hubEngine(home) : chromeEngine(home))
    engine.open(`http://127.0.0.1:${port}/`)
  }
  const openedAt = Date.now() - provenAt

  const changes: { t: number; loads: number; status: string | null; toasts: string[] }[] = []
  const origins = new Set<number>()
  let last = ''
  let everToasts = 0
  while (Date.now() - provenAt < WATCH_MS) {
    const sample = await engine.read()
    if (sample) {
      origins.add(sample.origin)
      everToasts = Math.max(everToasts, sample.toasts.length)
      const key = JSON.stringify([origins.size, sample.status, sample.toasts])
      if (key !== last) {
        last = key
        changes.push({ t: Date.now() - provenAt, loads: origins.size, status: sample.status, toasts: sample.toasts })
      }
    }
    await sleep(100)
  }
  const final = changes.at(-1)
  const events = logEvents(home, root)
    .filter(({ text }) => /^Ultimate: http|optimized dependencies changed|dependencies optimized|new dependencies|Core|closed|restart/i.test(text))
    .map(({ at, text }) => ({ t: Date.parse(at) - provenAt, text: text.slice(0, 80) }))
  await engine.close()
  await instance.stop()
  const summary = {
    condition: `${cache} ${browser} ${load}`,
    pageOpenedAfterLockMs: openedAt,
    pageLoads: origins.size,
    mostErrorToasts: everToasts,
    reconnecting: changes.some(({ status }) => status === 'reconnecting…'),
    settledAt: final?.t,
    final: final && { status: final.status, toasts: final.toasts },
    changes,
    events,
  }
  return summary
}

const runs = Number(process.argv[2] ?? 1)
const filter = process.argv[3] ?? ''
const model = await startScriptedModel()
const results: unknown[] = []
mkdirSync(EVIDENCE, { recursive: true })
try {
  for (let run = 0; run < runs; run++)
    for (const cache of ['fresh', 'warm'] as const)
      for (const browser of ['hub', 'chrome'] as const)
        for (const load of ['at-lock', 'after-ready'] as const) {
          if (!`${cache} ${browser} ${load}`.includes(filter)) continue
          const result = await measure(cache, browser, load, model.agentDir)
          results.push(result)
          console.log(JSON.stringify(result))
          writeFileSync(join(EVIDENCE, 'startup-measure.json'), JSON.stringify(results, null, 2))
        }
} finally {
  model.close()
  await cleanUp()
}
