import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BaseWindow, dialog, ipcMain, Menu, screen, webContents, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { MenuChoice, Point, Sheet } from '../shared/menu'
import {
  initialState,
  mainOf,
  portOf,
  reduce,
  selectedRoot,
  sidebarOf,
  sidebarWidth,
  type Command,
  type LifecycleAction,
  type SidebarForm,
  type ZoomStep,
} from '../shared/tabs'
import { createLifecycle } from './lifecycle'
import { createPages } from './pages'
import { loadSaved, storeSaved } from './saved'
import { createTerminals } from './terminal'
import { createScanner, createStatusPoller, type Scan } from './ultimate'
import { loadBounds, MIN_SIZE, placeWindow, rememberBounds } from './window'

// A new Ultimate must appear within about two seconds.
const SCAN_INTERVAL_MS = 1000
// The window buttons sit in the sidebar's top row, which is 40 points tall, and fit in the rail.
const TRAFFIC_LIGHTS = { x: 14, y: 13 }

const logged = new Set<string>()
function log(line: string) {
  // A bad file is seen again at every scan.
  if (logged.has(line)) return
  logged.add(line)
  console.error(line)
  try {
    appendFileSync(join(app.getPath('userData'), 'hub.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A full disk or a read-only folder must not stop the scans. The line went to stderr.
  }
}

// Each process saves only its own state, so a second one on the same user data would overwrite saved names.
if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  const savedFile = join(app.getPath('userData'), 'tabs.json')
  let state = initialState(loadSaved(savedFile, log))

  // The app takes no shortcut that Ultimate uses, such as ⌘K, mod+0, mod+b, or mod+1…9, so Actual Size has none.
  // The zoom roles act only on the focused view, which can be the sidebar, so these items set every page.
  const zoom = (step: ZoomStep) => () => dispatch({ type: 'zoom', step })
  const setMenu = (form: SidebarForm) =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            // onInput takes the key in every view, so the menu only shows it.
            {
              label: form === 'rail' ? 'Show Sidebar' : 'Hide Sidebar',
              accelerator: 'Shift+CommandOrControl+B',
              registerAccelerator: false,
              click: () => dispatch({ type: 'toggle-sidebar' }),
            },
            { type: 'separator' },
            { label: 'Actual Size', click: zoom('reset') },
            { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: zoom('in') },
            { label: 'Zoom In', accelerator: 'CommandOrControl+=', visible: false, click: zoom('in') },
            { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: zoom('out') },
          ],
        },
        { role: 'windowMenu' },
      ]),
    )
  setMenu(state.saved.sidebar)
  let savedJson = JSON.stringify(state.saved)
  let shellJson = ''

  const windowFile = join(app.getPath('userData'), 'window.json')
  const workAreas = screen.getAllDisplays().map(({ workArea }) => workArea)
  const window = new BaseWindow({
    ...placeWindow(loadBounds(windowFile, log), workAreas, screen.getPrimaryDisplay().workArea),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Ultimate Hub',
    backgroundColor: '#16181d',
    titleBarStyle: 'hidden',
    trafficLightPosition: TRAFFIC_LIGHTS,
  })
  rememberBounds(window, windowFile, log)
  window.on('closed', () => app.quit())
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore()
    app.focus({ steal: true })
  })

  // The whole window, under the pages: the sidebar on the left, and the "not running" messages on the right.
  // While search or a sheet is open, it goes over the pages, and its clear background lets the page show around the panel.
  const shell = new WebContentsView({ webPreferences: { preload: join(__dirname, '../preload/index.js') } })
  shell.setBackgroundColor('#00000000')
  // The preload can run lifecycle, terminal, and command IPC, so the view must never show another page.
  shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  shell.webContents.on('will-navigate', (event) => event.preventDefault())
  window.contentView.addChildView(shell)
  // The view that had the keyboard when search opened, or null while search is closed.
  let searchOpener: WebContents | null = null
  // The view that had the keyboard when the open sheet appeared, and the answer it waits for. Sheets show one at a time.
  let sheetOpener: WebContents | null = null
  let answerSheet: ((yes: boolean) => void) | null = null
  let sheetQueue: Promise<unknown> = Promise.resolve()
  const raised = () => searchOpener !== null || sheetOpener !== null
  // A press on the panel's handle gives the keyboard to the sidebar view. When the drag ends, the terminal or the page that had it last gets it back.
  let terminalHadKeyboard = false
  app.on('web-contents-created', (_event, contents) =>
    contents.on('focus', () => {
      if (contents !== shell.webContents) terminalHadKeyboard = terminals.hasFocus()
    }),
  )

  /** Returns whether tabs.json now holds the state. */
  function dispatch(command: Command): boolean {
    const form = state.saved.sidebar
    state = reduce(state, command, Date.now())
    const nextSaved = JSON.stringify(state.saved)
    if (nextSaved !== savedJson) {
      try {
        storeSaved(savedFile, state.saved)
        savedJson = nextSaved
      } catch (error) {
        // The tabs must still follow the scans. The save runs again at the next scan.
        log(`tabs.json: ${String(error)}`)
      }
    }
    const main = mainOf(state)
    const sidebar = sidebarOf(state)
    const inTerminal = terminals.hasFocus()
    const listed = new Set([...sidebar.groups.flatMap(({ rows }) => rows), ...sidebar.ungrouped].map(({ root }) => root))
    const panelMoved = terminals.sync(listed, selectedRoot(state))
    pages.sync(state, main, shell.webContents, raised())
    if (form !== state.saved.sidebar) setMenu(state.saved.sidebar)
    if (panelMoved || form !== state.saved.sidebar) layout()
    if (panelMoved && inTerminal) terminals.focus()
    // A page or a terminal that opens during search or a sheet must not cover it.
    if (raised() && window.contentView.children.at(-1) !== shell) window.contentView.addChildView(shell)
    const nextShell = JSON.stringify({ sidebar, main })
    if (nextShell !== shellJson) {
      shell.webContents.send('state', sidebar, main)
      shellJson = nextShell
    }
    return savedJson === nextSaved
  }

  const onInput = (event: Electron.Event, input: Electron.Input, from: WebContents) => {
    if (sheetOpener !== null) return
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'f' && input.meta && input.shift && !input.control && !input.alt) {
      event.preventDefault()
      openSearch(from)
    }
    if (input.key.toLowerCase() === 'b' && input.meta && input.shift && !input.control && !input.alt) {
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) dispatch({ type: 'toggle-sidebar' })
    }
    if (input.type === 'keyDown' && input.key === 'Tab' && input.control && !input.meta && !input.alt && searchOpener === null) {
      event.preventDefault()
      dispatch({ type: 'cycle', by: input.shift ? -1 : 1 })
    }
    // By physical key, because the character differs between keyboard layouts.
    if (input.code === 'Backquote' && input.control && !input.shift && !input.meta && !input.alt) {
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat && searchOpener === null) terminals.toggle()
    }
  }
  // While search or a sheet is open, it holds the keyboard and returns it when it closes.
  const focusMain = () => !raised() && pages.focus(shell.webContents)
  const width = () => sidebarWidth(state.saved.sidebar)
  const terminals = createTerminals(window, { onInput, log, relayout: layout, focusMain, sidebarWidth: width })
  const pages = createPages(window, onInput, () => terminals.mainHeight(), width)
  app.on('will-quit', () => terminals.endAll())
  shell.webContents.on('before-input-event', (event, input) => onInput(event, input, shell.webContents))

  function openSearch(from: WebContents) {
    searchOpener ??= from
    window.contentView.addChildView(shell)
    shell.webContents.focus()
    shell.webContents.send('search', searchOpener !== shell.webContents)
  }

  /** Closes search, and selects `root` if it is given. Refuses a tab that is no longer live, so no page opens at an old port. */
  function closeSearch(root: string | null): boolean {
    if (root !== null && portOf(state, root) === null) return false
    const opener = searchOpener
    searchOpener = null
    window.contentView.addChildView(shell, 0)
    if (root !== null) {
      dispatch({ type: 'select', root })
      pages.focus(shell.webContents)
    } else if (opener && !opener.isDestroyed()) opener.focus()
    return true
  }

  function layout() {
    const { width, height } = window.getContentBounds()
    shell.setBounds({ x: 0, y: 0, width, height })
    const panelHeight = terminals.layout()
    pages.layout()
    shell.webContents.send('panel', panelHeight)
  }
  window.on('resize', layout)
  layout()

  let waiting: ((scan: Scan) => void)[] = []
  const lifecycle = createLifecycle({
    state: () => state,
    dispatch,
    nextScan: () => new Promise((resolve) => waiting.push(resolve)),
    ask,
    log,
    logFolder: join(app.getPath('userData'), 'ultimate-logs'),
  })
  const fromShell = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === shell.webContents
  ipcMain.on('command', (event, command: Command) => {
    // Only the main process starts or ends an operation.
    if (fromShell(event) && !command.type.startsWith('lifecycle')) dispatch(command)
  })
  // Native menus draw over the page views, which cover everything to the right of the sidebar.
  ipcMain.handle('pick', (event, items: MenuChoice[], at: Point) => (fromShell(event) ? pick(items, at) : null))
  ipcMain.on('panel-height', (event, height: unknown) => {
    if (fromShell(event) && typeof height === 'number' && Number.isFinite(height)) terminals.resize(height)
  })
  ipcMain.on('panel-drag-end', (event) => {
    if (!fromShell(event)) return
    if (terminalHadKeyboard) terminals.focus()
    else focusMain()
  })
  ipcMain.handle('ask', (event, sheet: Sheet) => (fromShell(event) ? ask(sheet) : false))
  ipcMain.on('sheet-answer', (event, yes: unknown) => {
    if (fromShell(event)) answerSheet?.(yes === true)
  })
  ipcMain.on('toggle-terminal', (event) => {
    if (fromShell(event) && !raised()) terminals.toggle()
  })
  // The picker is a sheet on the window, so it blocks the window until it closes. Resolves whether a folder was chosen.
  let picking = false
  ipcMain.handle('add-ultimate', async (event) => {
    if (!fromShell(event) || raised() || picking) return false
    picking = true
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        title: 'Open project on this Mac',
        buttonLabel: 'Open in Hub',
        properties: ['openDirectory'],
      })
      if (canceled || filePaths.length === 0 || window.isDestroyed()) return false
      void lifecycle.add(filePaths[0])
      return true
    } finally {
      picking = false
    }
  })
  ipcMain.on('open-search', (event) => {
    if (fromShell(event) && sheetOpener === null) openSearch(shell.webContents)
  })
  ipcMain.handle('close-search', (event, root: string | null) => (fromShell(event) ? closeSearch(root) : false))
  ipcMain.on('lifecycle', (event, root: unknown, action: unknown) => {
    if (!fromShell(event) || typeof root !== 'string' || !state.saved.tabs.some((tab) => tab.root === root)) return
    if (action === 'pause' || action === 'play' || action === 'close') lifecycle.act(root, action satisfies LifecycleAction)
  })

  function pick(items: MenuChoice[], at: Point): Promise<string | null> {
    return new Promise((resolve) => {
      const menu = Menu.buildFromTemplate(
        items.map((item) =>
          'heading' in item
            ? { type: 'header', label: item.heading }
            : { label: item.label, type: item.checked ? 'checkbox' : 'normal', checked: item.checked, enabled: item.enabled ?? true, click: () => resolve(item.id) },
        ),
      )
      // A choice calls both the click and this callback. The click must win, so the null waits one task.
      menu.popup({ window, x: Math.round(at.x), y: Math.round(at.y), callback: () => setTimeout(() => resolve(null)) })
    })
  }

  /** Resolves true only for the action. Cancel has the keyboard first, so Return or Escape never stops a server. */
  function ask(sheet: Sheet): Promise<boolean> {
    const answer = sheetQueue.then(() => showSheet(sheet))
    sheetQueue = answer
    return answer
  }

  function showSheet(sheet: Sheet): Promise<boolean> {
    if (searchOpener) closeSearch(null)
    sheetOpener = webContents.getFocusedWebContents() ?? shell.webContents
    window.contentView.addChildView(shell)
    shell.webContents.focus()
    shell.webContents.send('sheet', sheet)
    return new Promise((resolve) => {
      answerSheet = (yes) => {
        const opener = sheetOpener
        answerSheet = null
        sheetOpener = null
        window.contentView.addChildView(shell, 0)
        if (opener && opener !== shell.webContents && !opener.isDestroyed()) opener.focus()
        resolve(yes)
      }
    })
  }
  const loadShell = () => shell.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  shell.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) loadShell().catch((error) => log(`shell: ${String(error)}`))
  })
  // A new sidebar has no tabs, so the next scan must send them even if nothing has changed.
  shell.webContents.on('did-finish-load', () => {
    shellJson = ''
    layout()
    if (searchOpener) closeSearch(null)
    answerSheet?.(false)
  })
  await loadShell()

  const scanInstances = createScanner(log)
  const pollStatus = createStatusPoller(log, (command) => {
    if (!window.isDestroyed()) dispatch(command)
  })
  async function scan() {
    const waiters = waiting
    waiting = []
    try {
      const result = await scanInstances()
      // The user can close the window while a scan runs.
      if (window.isDestroyed()) return
      dispatch({ type: 'scan', ...result })
      pollStatus(result.instances, (root) => state.seenAt[root])
      for (const resolve of waiters) resolve(result)
    } catch (error) {
      log(`scan: ${String(error)}`)
      waiting = [...waiters, ...waiting]
    }
    // A loop that stops leaves tabs on ports that no longer belong to them.
    setTimeout(scan, SCAN_INTERVAL_MS)
  }
  void scan()
})
