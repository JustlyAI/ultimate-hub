import { createHash } from 'node:crypto'
import { type BaseWindow, type Input, shell, type WebContents, WebContentsView } from 'electron'
import { portOf, type MainArea, type TabsState } from '../shared/tabs'

type Page = { view: WebContentsView; port: number }

const addressOf = (port: number) => `http://127.0.0.1:${port}`

// A port can pass from one project to another, and browser storage belongs to an origin, which includes the port.
// Without a session for each project, one project's drafts appear in another project's tab.
const partitionOf = (root: string) => `persist:${createHash('sha256').update(root).digest('hex').slice(0, 16)}`

function openExternal(url: string) {
  if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
}

/** One view for each live tab that has been opened. `sync` converges them on the state, so it is safe to repeat. */
export function createPages(
  window: BaseWindow,
  onInput: (event: Electron.Event, input: Input, from: WebContents) => void,
  mainHeight: () => number,
  sidebarWidth: () => number,
) {
  const pages = new Map<string, Page>()
  let shown: string | null = null
  let zoom = 1

  function layout(page: Page) {
    const { width } = window.getContentBounds()
    const left = sidebarWidth()
    page.view.setBounds({ x: left, y: 0, width: width - left, height: mainHeight() })
  }

  function close(root: string) {
    const page = pages.get(root)
    // A page can crash or fail to load while the window closes.
    if (!page || window.isDestroyed()) return
    pages.delete(root)
    window.contentView.removeChildView(page.view)
    page.view.webContents.close()
  }

  function open(root: string, port: number) {
    const view = new WebContentsView({ webPreferences: { partition: partitionOf(root), focusOnNavigation: false } })
    const page = { view, port }
    const contents = view.webContents
    view.setBackgroundColor('#16181d')
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    const keepOnProject = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      // An iframe can show any site. Only the main frame decides which project the tab shows.
      if (!event.isMainFrame || new URL(event.url).origin === addressOf(page.port)) return
      event.preventDefault()
      openExternal(event.url)
    }
    contents.on('will-navigate', keepOnProject)
    contents.on('will-redirect', keepOnProject)
    contents.on('before-input-event', (event, input) => onInput(event, input, contents))
    // A zoom set before the first load is lost, and Chromium can remember another level for this session.
    contents.on('did-navigate', () => contents.setZoomFactor(zoom))
    // Closing the view leaves the plain background. The next scan opens the page again if the project still runs.
    contents.on('did-fail-load', (_event, code, _text, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) close(root)
    })
    contents.on('render-process-gone', () => close(root))
    pages.set(root, page)
    window.contentView.addChildView(view)
    layout(page)
    load(page)
  }

  function load({ view, port }: Page) {
    view.webContents.loadURL(addressOf(port)).catch(() => {})
  }

  return {
    /** With `holdFocus`, the keyboard stays where it is, because search has it. */
    sync(state: TabsState, main: MainArea, sidebar: WebContents, holdFocus: boolean) {
      if (state.saved.zoom !== zoom) {
        zoom = state.saved.zoom
        for (const { view } of pages.values()) view.webContents.setZoomFactor(zoom)
      }
      for (const [root, page] of pages) {
        const port = portOf(state, root)
        if (port === null) close(root)
        else if (port !== page.port) {
          page.port = port
          load(page)
        }
      }
      let focusNewView = false
      if (main.kind === 'page' && !pages.has(main.root)) {
        focusNewView = !sidebar.isFocused()
        open(main.root, main.port)
      }
      const next = main.kind === 'page' ? main.root : null
      for (const [root, { view }] of pages) view.setVisible(root === next)
      if (next === shown && !focusNewView) return
      shown = next
      if (holdFocus) return
      if (next) pages.get(next)?.view.webContents.focus()
      else sidebar.focus()
    },
    layout() {
      for (const page of pages.values()) layout(page)
    },
    /** Focuses the shown page, or the sidebar when no page shows. */
    focus(sidebar: WebContents) {
      const page = shown === null ? undefined : pages.get(shown)
      ;(page?.view.webContents ?? sidebar).focus()
    },
  }
}
