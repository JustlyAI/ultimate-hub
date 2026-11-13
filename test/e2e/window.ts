import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BareHub } from '../support/bare.ts'
import { tempDir, until } from '../support/fixtures.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

type Rect = { x: number; y: number; width: number; height: number }

const bounds = (hub: BareHub) => hub.main(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getBounds())
const savedIn = (userData: string): Rect | null =>
  existsSync(join(userData, 'window.json')) ? JSON.parse(readFileSync(join(userData, 'window.json'), 'utf8')) : null

/** Moves and resizes the window from the main process, because a real drag needs an Accessibility permission. */
async function moveTo(hub: BareHub, target: Rect): Promise<Rect> {
  await hub.main(({ BaseWindow }, target) => BaseWindow.getAllWindows()[0].setBounds(target), target)
  return until('the new bounds', async () => {
    const now = await bounds(hub)
    return now.width === target.width && now.height === target.height ? now : null
  }, 3000)
}

/** The default: 1400 by 900, or the work area if smaller, centered on the main display. */
async function expectedDefault(hub: BareHub): Promise<Rect> {
  const area = await hub.main(({ screen }) => screen.getPrimaryDisplay().workArea)
  const width = Math.min(1400, area.width)
  const height = Math.min(900, area.height)
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
}

async function shellShot(hub: BareHub, name: string) {
  const png = await hub.main(async ({ BaseWindow }) => {
    const shell = BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView
    return (await shell.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(join(EVIDENCE, name), Buffer.from(png, 'base64'))
}

export async function runWindowChecks(check: Check) {
  await check('window', 'a moved and resized window opens at the same bounds after a quit (moved from the main process)', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    let hub = await BareHub.launch(home, userData)
    const placed = await moveTo(hub, { x: 150, y: 120, width: 900, height: 600 })
    assert.equal(await hub.closeWindowAndWait(), 0)
    assert.deepEqual(savedIn(userData), placed, 'window.json')
    hub = await BareHub.launch(home, userData)
    try {
      assert.deepEqual(await bounds(hub), placed)
      return `moved to ${JSON.stringify(placed)}, closed the window, and the next launch opened at ${JSON.stringify(await bounds(hub))}`
    } finally {
      await hub.quit()
    }
  })

  await check('window', 'the last bounds survive a crash: the app saves them soon after a move, not only at close', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    let hub = await BareHub.launch(home, userData)
    const placed = await moveTo(hub, { x: 260, y: 140, width: 1000, height: 650 })
    const startedAt = Date.now()
    await until('window.json to hold the new bounds', () => JSON.stringify(savedIn(userData)) === JSON.stringify(placed), 3000)
    const savedAfter = Date.now() - startedAt
    process.kill(hub.pid, 'SIGKILL')
    await hub.quit()
    hub = await BareHub.launch(home, userData)
    try {
      assert.deepEqual(await bounds(hub), placed)
      return `window.json held the new bounds ${savedAfter} ms after the move. After SIGKILL, the next launch opened at ${JSON.stringify(placed)}`
    } finally {
      await hub.quit()
    }
  })

  await check('window', 'full screen is not restored: the next launch opens at the bounds from before full screen', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    let hub = await BareHub.launch(home, userData)
    const placed = await moveTo(hub, { x: 200, y: 100, width: 1000, height: 600 })
    // The bounds and the close must come after the macOS full screen animation, not during it.
    await hub.main(({ BaseWindow }) => {
      const window = BaseWindow.getAllWindows()[0]
      const entered = new Promise((resolve) => window.once('enter-full-screen', () => resolve(null)))
      window.setFullScreen(true)
      return Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('no enter-full-screen in 5 s')), 5000))])
    })
    const fullBounds = await bounds(hub)
    assert.notDeepEqual(fullBounds, placed, 'full screen changes the bounds')
    assert.equal(await hub.closeWindowAndWait(), 0)
    hub = await BareHub.launch(home, userData)
    try {
      const reopened = await hub.main(({ BaseWindow }) => ({ full: BaseWindow.getAllWindows()[0].isFullScreen(), bounds: BaseWindow.getAllWindows()[0].getBounds() }))
      assert.deepEqual(reopened, { full: false, bounds: placed })
      return `full screen was ${JSON.stringify(fullBounds)}. The window closed in full screen, and the next launch opened in a normal window at ${JSON.stringify(placed)}`
    } finally {
      await hub.quit()
    }
  })

  await check('window', 'saved bounds off every display open at the default size, centered on the main display', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const offDisplays = { x: -100000, y: -100000, width: 1200, height: 800 }
    writeFileSync(join(userData, 'window.json'), JSON.stringify(offDisplays))
    const hub = await BareHub.launch(home, userData)
    try {
      const shown = await hub.main(({ screen }) => screen.getAllDisplays().map(({ workArea }) => workArea))
      const expected = await expectedDefault(hub)
      assert.deepEqual(await bounds(hub), expected)
      await until('the empty message', () => hub.inShell<boolean>(`document.querySelector('#message')?.innerText.includes('No Ultimate running')`))
      await shellShot(hub, 'window-off-display.png')
      return `saved ${JSON.stringify(offDisplays)} with work areas ${JSON.stringify(shown)}. Opened at ${JSON.stringify(expected)}. Screenshot window-off-display.png`
    } finally {
      await hub.quit()
    }
  })

  await check('window', 'a bad window.json opens at the default and writes one log line', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    writeFileSync(join(userData, 'window.json'), '{"x": 10, "y": "top"')
    const hub = await BareHub.launch(home, userData)
    try {
      assert.deepEqual(await bounds(hub), await expectedDefault(hub))
      const lines = readFileSync(join(userData, 'hub.log'), 'utf8').split('\n').filter((line) => line.includes('window.json'))
      assert.equal(lines.length, 1, lines.join('\n'))
      return `opened at the default ${JSON.stringify(await bounds(hub))}. hub.log: "${lines[0].slice(25)}"`
    } finally {
      await hub.quit()
    }
  })
}
