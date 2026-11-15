// Records the README demo from the packaged app and real Ultimates, then renders it. Run with Node 26: node scripts/demo.ts
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { send, settled, showProject as showUltimate } from '../test/e2e/real.ts'
import { cleanUp, makeProject, sleep, startUltimate, tempDir, until, type RealUltimate } from '../test/support/fixtures.ts'
import { Hub } from '../test/support/hub.ts'

/** A point in the window, in CSS pixels. */
export type Point = { x: number; y: number }
/** One capture of the window. The cursor follows `path` over the previous frame, and clicks at its end, or presses at its start and drags when `drag` is set. */
export type Frame = { shot: string; hold: number; path?: Point[]; drag?: boolean; cut?: boolean }
export type Scene = { caption: string; frames: Frame[] }
export type Timeline = { window: { width: number; height: number }; scenes: Scene[] }

const WINDOW = { width: 1280, height: 800 }
const OUT = join(import.meta.dirname, '../docs/demo')
const ELECTRON = join(import.meta.dirname, '../node_modules/.bin/electron')

/** What the demo model does with each prompt, and the title it gives the conversation. */
const SCRIPT = [
  { word: 'migration', title: 'Ship the migration', ask: 'Run the migration on production now?' },
  { word: 'release notes', title: 'Release notes', reply: 'Reading the commits since the last tag. ', hold: true },
  { word: 'typos', title: 'README check', reply: 'The README has no typos.', delayMs: 5000 },
]

/** The approach of startScriptedModel in test/support/fixtures.ts, with replies that read well on screen. */
async function startDemoModel() {
  let held: (() => void)[] = []
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', created: 0, model: 'demo-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', async () => {
      const { messages, tools } = JSON.parse(body) as { messages: { role: string; content: unknown }[]; tools?: unknown[] }
      const content = messages.at(-1)!.content
      const text = typeof content === 'string' ? content : (content as { text?: string }[]).map((part) => part.text ?? '').join('')
      const step = SCRIPT.find(({ word }) => text.includes(word))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const say = (words: string) => response.write(chunk({ role: 'assistant', content: words }))
      if (!tools?.length) say(step?.title ?? 'Conversation')
      else if (messages.at(-1)!.role !== 'user' || !step) say('Okay.')
      else if (step.ask) {
        const args = { to: 'user', text: step.ask, questions: [{ text: step.ask, kind: 'confirm' }] }
        response.write(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'message', arguments: JSON.stringify(args) } }] }))
        response.write(chunk({}, 'tool_calls'))
        return response.end('data: [DONE]\n\n')
      } else {
        await sleep(step.delayMs ?? 0)
        say(step.reply!)
        if (step.hold) await new Promise<void>((resolve) => held.push(resolve))
      }
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const agentDir = tempDir('agent')
  const provider = { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'demo', models: [{ id: 'demo-1', input: ['text', 'image'] }] }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { demo: provider } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'demo', defaultModel: 'demo-1' }))
  return {
    agentDir,
    release() {
      for (const resolve of held) resolve()
      held = []
    },
    close: () => server.close(),
  }
}

/** Ultimate shows os.hostname() on its home page, and has no setting for it. */
const hideHostname = (page: Page) =>
  page.evaluate((host) => {
    const holder = window as unknown as { hostHidden?: boolean }
    if (holder.hostHidden) return
    holder.hostHidden = true
    const replace = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue!.includes(host)) node.nodeValue = node.nodeValue!.replaceAll(host, 'my-mac.local')
    }
    replace()
    new MutationObserver(replace).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, hostname())

async function record(dir: string): Promise<Timeline> {
  const home = tempDir('home')
  mkdirSync(join(home, '.ultimate'))
  writeFileSync(join(home, '.ultimate/settings.json'), JSON.stringify({ onboarding: false, summaryModel: 'demo/demo-1' }))
  const projects = tempDir('projects')
  const zdot = tempDir('zdot')
  writeFileSync(join(zdot, '.zshrc'), "PROMPT='%F{blue}%1~%f %# '\n")
  const model = await startDemoModel()
  const roots = Object.fromEntries(['website', 'api', 'docs', 'mobile-app'].map((name) => [name, makeProject(projects, name)]))
  const running: RealUltimate[] = ['website', 'api', 'docs'].map((name) => startUltimate(home, roots[name], model.agentDir))
  await Promise.all(running.map((ultimate) => ultimate.port()))
  const hub = await Hub.launch(home, tempDir('data'), { SHELL: '/bin/zsh', ZDOTDIR: zdot, LANG: 'en_US.UTF-8' })
  const scenes: Scene[] = []
  let count = 0
  const begin = (caption: string) => scenes.push({ caption, frames: [] })
  const frame = async ({ hold = 1.1, path, drag, cut, settle = 300 }: Partial<Omit<Frame, 'shot'>> & { settle?: number } = {}) => {
    await sleep(settle)
    const shot = join(dir, `${String(count++).padStart(3, '0')}.png`)
    await hub.screenshot(shot)
    scenes.at(-1)!.frames.push({ shot: basename(shot), hold, path, drag, cut })
  }
  const pageOrigin = () =>
    hub.evaluate(({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
      const page = views.find((view) => view.getVisible() && !view.webContents.getURL().startsWith('file:'))!
      return { x: page.getBounds().x, y: page.getBounds().y }
    }, null)
  const center = async (locator: Locator, origin: Point = { x: 0, y: 0 }): Promise<Point> => {
    const box = (await locator.boundingBox())!
    return { x: Math.round(origin.x + box.x + box.width / 2), y: Math.round(origin.y + box.y + box.height / 2) }
  }
  const typeOnCamera = async (type: (text: string) => Promise<unknown>, text: string) => {
    for (let at = 0; at < text.length; at += 2) {
      await type(text.slice(at, at + 2))
      await frame({ hold: 0.12, cut: true, settle: 40 })
    }
  }
  const showProject = async (...args: Parameters<typeof showUltimate>) => {
    const page = await showUltimate(...args)
    await hideHostname(page)
    return page
  }
  const settle = async (name: string) => {
    const page = await showProject(hub, name, roots[name])
    await settled(home, roots[name], page)
    await hideHostname(page)
  }
  const clickRow = async (label: string, list: '#top' | '#status' = '#top') => {
    const row = hub.shell().locator(`${list} .tab`, { has: hub.shell().locator(`.label:text-is("${label}")`) })
    const at = await center(row)
    await row.click()
    return at
  }
  const groupOf = (label: string, group: string) => until(`${label} in ${group}`, async () => (await hub.groupOf(label)) === group, 30000)

  try {
    await hub.evaluate(({ BaseWindow }, size) => BaseWindow.getAllWindows()[0].setContentSize(size.width, size.height), WINDOW)
    await until('three tabs', async () => (await hub.topRows()).length === 3, 20000)
    for (const name of ['api', 'docs', 'website']) await settle(name)

    begin('Every Ultimate on your Mac, in one window.')
    await frame({ hold: 2.5 })

    begin('Click a tab to switch to that Ultimate.')
    for (const name of ['api', 'docs']) {
      const path = [await clickRow(name)]
      await showProject(hub, name, roots[name])
      await frame({ path, hold: 1.2 })
    }

    begin('Start another Ultimate, and its tab appears.')
    const mobile = startUltimate(home, roots['mobile-app'], model.agentDir)
    running.push(mobile)
    await mobile.port()
    await until('four tabs', async () => (await hub.topRows()).length === 4, 20000)
    await frame({ hold: 1.4, settle: 2500 })
    {
      const path = [await clickRow('mobile-app')]
      await settle('mobile-app')
      await frame({ path, hold: 1.4 })
    }

    begin('Put tabs in a group.')
    await hub.planMenus(['Group'])
    {
      const path = [await center(hub.shell().locator('#add'))]
      await hub.shell().locator('#add').click()
      await frame({ path, hold: 0.6 })
    }
    await typeOnCamera((text) => hub.shell().locator('#name-input').pressSequentially(text), 'Acme')
    {
      const path = [await center(hub.shell().locator('#name-ok'))]
      await hub.shell().locator('#name-ok').click()
      await until('the group', () => hub.groupHeader('Acme').count())
      await frame({ path, hold: 0.8 })
    }
    for (const name of ['website', 'api']) {
      const path = [await center(hub.topRow(name)), await center(hub.groupHeader('Acme'))]
      await hub.topRow(name).dragTo(hub.groupHeader('Acme'))
      await until(`${name} in Acme`, async () => (await hub.topNames()).find(([, labels]) => labels.includes(name))?.[0] === 'Acme')
      await frame({ path, drag: true, hold: 1 })
    }

    begin('Work in each Ultimate as usual.')
    {
      const path = [await clickRow('api')]
      const page = await showProject(hub, 'api', roots.api)
      await frame({ path, hold: 0.6 })
      const composer = page.locator('#composer-input')
      const at = [await center(composer, await pageOrigin())]
      await composer.click()
      await frame({ path: at, hold: 0.3, cut: true, settle: 100 })
      await typeOnCamera((text) => composer.pressSequentially(text), 'Is the migration ready to ship?')
      await composer.press('Enter')
      await until('the question', () => page.getByRole('button', { name: 'Yes' }).count(), 30000)
      await frame({ hold: 2.2, settle: 800 })
    }

    for (const [name, prompt] of [['website', 'Draft the release notes'], ['docs', 'Check the README for typos']]) {
      await send(await showProject(hub, name, roots[name]), prompt)
      await sleep(500)
    }
    begin('Status shows which Ultimate needs you, works, or is done.')
    {
      const path = [await clickRow('mobile-app')]
      await groupOf('api', 'needs-you')
      await groupOf('website', 'working')
      await groupOf('docs', 'done')
      await frame({ path, hold: 2.5 })
      const back = [await clickRow('api', '#status')]
      await showProject(hub, 'api', roots.api)
      await frame({ path: back, hold: 1.6 })
    }

    begin('Hide the sidebar, and each tab keeps its status dot.')
    for (const hold of [2.4, 0.8]) {
      const path = [await center(hub.shell().locator('#sidebar-toggle'))]
      await hub.shell().locator('#sidebar-toggle').click()
      await frame({ path, hold, settle: 600 })
    }

    begin("Each tab has a terminal in its project's folder.")
    {
      const path = [await center(hub.shell().locator('#terminal-toggle'))]
      await hub.shell().locator('#terminal-toggle').click()
      const terminal = await hub.terminalPage()
      await until('the prompt', async () => (await terminal.locator('.xterm-rows').innerText()).includes('api'), 10000)
      await frame({ path, hold: 0.6, settle: 500 })
      await typeOnCamera((text) => terminal.keyboard.type(text), 'git log --oneline')
      await terminal.keyboard.press('Enter')
      await until('the log', async () => (await terminal.locator('.xterm-rows').innerText()).includes('init'), 10000)
      await frame({ hold: 2.2 })
    }

    begin('⌘⇧F finds any tab.')
    {
      const path = [await center(hub.shell().locator('#search-open'))]
      await hub.shell().locator('#search-open').click()
      await frame({ path, hold: 0.6 })
      await typeOnCamera((text) => hub.shell().locator('#search-input').pressSequentially(text), 'docs')
      await frame({ hold: 1 })
      await hub.shell().locator('#search-input').press('Enter')
      await showProject(hub, 'docs', roots.docs).catch(() => {})
      await frame({ hold: 2.4, settle: 600 })
    }
    return { window: WINDOW, scenes }
  } finally {
    model.release()
    await hub.quit().catch(() => hub.forceStop())
    await Promise.all(running.map((ultimate) => ultimate.stop()))
    model.close()
  }
}

const work = tempDir('demo')
const shots = join(work, 'shots')
mkdirSync(shots)
mkdirSync(OUT, { recursive: true })
try {
  const timeline = await record(shots)
  writeFileSync(join(shots, 'timeline.json'), JSON.stringify(timeline, null, 2))
  const mp4 = join(OUT, 'ultimate-hub.mp4')
  execFileSync(ELECTRON, [join(import.meta.dirname, 'demo-render.mjs'), shots, mp4, join(work, 'electron')], { stdio: 'inherit', env: { ...process.env, HOME: work } })
  const gif = join(OUT, 'ultimate-hub.gif')
  const palette = 'fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', palette, gif], { stdio: 'inherit' })
  for (const file of [mp4, gif]) console.log(`${file} ${(statSync(file).size / 1e6).toFixed(1)} MB`)
  if (process.env.DEMO_KEEP) execFileSync('cp', ['-R', shots, process.env.DEMO_KEEP])
} finally {
  await cleanUp()
}
