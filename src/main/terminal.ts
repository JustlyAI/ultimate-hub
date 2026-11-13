import { statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { type BaseWindow, type Input, ipcMain, type IpcMainEvent, type WebContents, WebContentsView } from 'electron'
import { type IPty, spawn } from 'node-pty'
import { PANEL_GAP } from '../shared/tabs'

const MIN_PANEL_HEIGHT = 100
const MIN_PAGE_HEIGHT = 120

// `pty` is null until the view reports its size, so that the shell starts at the size it shows.
type Terminal = { view: WebContentsView; pty: IPty | null }

// One for the window, for this run only. A null height means one third of the window.
type Panel = { shown: boolean; height: number | null }

type Options = {
  onInput: (event: Electron.Event, input: Input, from: WebContents) => void
  log: (line: string) => void
  relayout: () => void
  focusMain: () => void
  sidebarWidth: () => number
}

function shellCommand() {
  const file = process.env.SHELL || userInfo().shell || '/bin/zsh'
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color' }
  // An app opened from Finder has no LANG, and a shell in the C locale garbles wide characters.
  env.LANG ||= 'en_US.UTF-8'
  return { file, env }
}

const isSize = (value: unknown) => Number.isInteger(value) && (value as number) > 0

/** One shell for each project root, each in its own view, and the panel that shows the selected tab's shell. */
export function createTerminals(window: BaseWindow, { onInput, log, relayout, focusMain, sidebarWidth }: Options) {
  const terminals = new Map<string, Terminal>()
  const panel: Panel = { shown: false, height: null }
  let selected: string | null = null

  const shownRoot = () => (panel.shown ? selected : null)
  const windowHeight = () => window.getContentBounds().height

  const limited = (height: number, total: number) => Math.max(MIN_PANEL_HEIGHT, Math.min(height, total - PANEL_GAP - MIN_PAGE_HEIGHT))
  const panelHeight = (total: number) => limited(panel.height ?? Math.round(total / 3), total)

  function open(root: string): boolean {
    if (terminals.has(root)) return true
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a folder')
    } catch (error) {
      log(`terminal ${root}: ${String(error)}`)
      return false
    }
    const view = new WebContentsView({ webPreferences: { preload: join(__dirname, '../preload/terminal.js'), focusOnNavigation: false } })
    const contents = view.webContents
    view.setBackgroundColor('#101114')
    view.setVisible(false)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A file dropped on the view would replace the terminal with the file.
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('before-input-event', (event, input) => onInput(event, input, contents))
    contents.on('render-process-gone', () => ended(root))
    terminals.set(root, { view, pty: null })
    window.contentView.addChildView(view)
    contents.loadFile(join(__dirname, '../renderer/terminal.html')).catch((error) => log(`terminal ${root}: ${String(error)}`))
    return true
  }

  function start(root: string, terminal: Terminal, cols: number, rows: number) {
    const { file, env } = shellCommand()
    try {
      terminal.pty = spawn(file, ['-l'], { name: 'xterm-256color', cols, rows, cwd: root, env })
    } catch (error) {
      log(`terminal ${root}: ${String(error)}`)
      ended(root)
      return
    }
    const pty = terminal.pty
    // A shell that the app ends can still write after its view is closed.
    const isLive = () => terminals.get(root)?.pty === pty
    pty.onData((data) => {
      if (isLive()) terminal.view.webContents.send('terminal:data', data)
    })
    pty.onExit(() => {
      if (!isLive()) return
      // The process is gone, and its PID can belong to another process now.
      terminal.pty = null
      ended(root)
    })
  }

  /** Returns true if the panel was showing this shell. */
  function end(root: string): boolean {
    const terminal = terminals.get(root)
    if (!terminal) return false
    const wasShown = shownRoot() === root
    terminals.delete(root)
    if (wasShown) panel.shown = false
    terminal.pty?.kill('SIGHUP')
    if (!window.isDestroyed()) window.contentView.removeChildView(terminal.view)
    if (!terminal.view.webContents.isDestroyed()) terminal.view.webContents.close()
    return wasShown
  }

  function ended(root: string) {
    if (!end(root) || window.isDestroyed()) return
    relayout()
    focusMain()
  }

  const terminalOf = (event: IpcMainEvent) => [...terminals].find(([, terminal]) => terminal.view.webContents === event.sender)

  ipcMain.on('terminal:ready', (event, cols: unknown, rows: unknown) => {
    const found = terminalOf(event)
    if (found && !found[1].pty && isSize(cols) && isSize(rows)) start(found[0], found[1], cols as number, rows as number)
  })
  ipcMain.on('terminal:input', (event, data: unknown) => {
    if (typeof data === 'string') terminalOf(event)?.[1].pty?.write(data)
  })
  ipcMain.on('terminal:resize', (event, cols: unknown, rows: unknown) => {
    if (isSize(cols) && isSize(rows)) terminalOf(event)?.[1].pty?.resize(cols as number, rows as number)
  })

  return {
    toggle() {
      if (selected === null) return
      if (panel.shown) {
        panel.shown = false
        relayout()
        focusMain()
      } else if (open(selected)) {
        panel.shown = true
        relayout()
        terminals.get(selected)!.view.webContents.focus()
      }
    },
    /** Ends the shells of tabs that left the list, and follows the selection. Returns true if the layout must change. */
    sync(listed: ReadonlySet<string>, nextSelected: string | null): boolean {
      const before = shownRoot()
      for (const root of terminals.keys()) if (!listed.has(root)) end(root)
      selected = nextSelected
      if (panel.shown && (selected === null || !open(selected))) panel.shown = false
      return shownRoot() !== before
    },
    resize(height: number) {
      panel.height = limited(Math.round(height), windowHeight())
      relayout()
    },
    /** Places the shown shell's view, hides the others, and returns the panel's height, or 0. */
    layout(): number {
      const { width, height } = window.getContentBounds()
      const root = shownRoot()
      const shownHeight = root === null ? 0 : panelHeight(height)
      const left = sidebarWidth()
      for (const [key, { view }] of terminals) {
        view.setVisible(key === root)
        if (key === root) view.setBounds({ x: left, y: height - shownHeight, width: width - left, height: shownHeight })
      }
      return shownHeight
    },
    mainHeight(): number {
      const height = windowHeight()
      return shownRoot() === null ? height : height - panelHeight(height) - PANEL_GAP
    },
    hasFocus: () => [...terminals.values()].some(({ view }) => view.webContents.isFocused()),
    focus() {
      const root = shownRoot()
      if (root !== null) terminals.get(root)!.view.webContents.focus()
    },
    endAll() {
      for (const root of [...terminals.keys()]) end(root)
    },
  }
}
