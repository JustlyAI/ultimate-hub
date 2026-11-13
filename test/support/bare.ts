import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cleanEnv, processTree, sleep, until } from './fixtures.ts'
import { APP, type TabRow } from './hub.ts'

/**
 * Drives the packaged app through the main process inspector only. Playwright attaches to each page and turns on focus
 * emulation, so its hidden pages report `visible`. Switch time, memory, and hidden tabs need pages that nothing touches.
 */
export class BareHub {
  private readonly child: ChildProcess
  private readonly socket: WebSocket
  private nextId = 1
  private readonly waiting = new Map<number, (message: { result?: { result: { value: unknown }; exceptionDetails?: { exception?: { description?: string } } } }) => void>()

  private constructor(child: ChildProcess, socket: WebSocket) {
    this.child = child
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      this.waiting.get(message.id)?.(message)
      this.waiting.delete(message.id)
    })
  }

  static async launch(home: string, userData: string, app = APP): Promise<BareHub> {
    const child = spawn(app, ['--inspect=0', `--user-data-dir=${userData}`], {
      env: cleanEnv(home),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (data) => (stderr += data))
    const url = await until('the inspector address', () => stderr.match(/ws:\/\/\S+/)?.[0], 15000)
    const socket = new WebSocket(url)
    await once(socket as unknown as EventTarget, 'open')
    const hub = new BareHub(child, socket)
    await until('the shell', () => hub.inShell('document.readyState === "complete"'))
    return hub
  }

  get pid(): number {
    return this.child.pid!
  }

  tree(): number[] {
    return processTree(this.pid)
  }

  /** Runs a function in the app's main process. It gets the electron module and `arg`. */
  async main<R, A = null>(fn: (electron: typeof import('electron'), arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    const id = this.nextId++
    const reply = new Promise<Parameters<typeof this.waiting extends Map<number, infer F> ? F : never>[0]>((resolve) =>
      this.waiting.set(id, resolve as never),
    )
    this.socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          // Electron comes from the app's main module, which exists only once Electron has started. A bare `require` this early
          // can load the npm `electron` package, which starts its download script with the app's binary: a second app on the
          // real user data folder, and a main process that blocks until it exits.
          expression: `(${fn.toString()})(process.mainModule.require('electron'), ${JSON.stringify(arg ?? null)})`,
          includeCommandLineAPI: true,
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    )
    // An evaluation that never answers would stop the whole run with no message.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the main process gave no answer in 20 s to ${fn.toString().replace(/\s+/g, ' ').slice(0, 120)}`)), 20000)
    })
    const { result } = await Promise.race([reply, late]).finally(() => clearTimeout(timer))
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'main process error')
    return result?.result.value as R
  }

  inShell<R>(code: string): Promise<R> {
    return this.main(
      ({ BaseWindow }, code) =>
        (BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.executeJavaScript(code),
      code,
    )
  }

  /** Runs code in the page that is on screen. */
  inShown<R>(code: string): Promise<R> {
    return this.main(({ BaseWindow }, code) => {
      const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
      return pages.find((view) => view.getVisible())!.webContents.executeJavaScript(code)
    }, code)
  }

  /** Runs code in every open page, and returns the results in view order. */
  inAllPages<R>(code: string): Promise<R[]> {
    return this.main(({ BaseWindow }, code) => {
      const pages = BaseWindow.getAllWindows()[0].contentView.children.slice(1) as Electron.WebContentsView[]
      return Promise.all(pages.map((view) => view.webContents.executeJavaScript(code)))
    }, code)
  }

  topRows(): Promise<TabRow[]> {
    return this.inShell(`[...document.querySelectorAll('#top .tab')].map((element) => ({
      label: element.querySelector('.label').textContent,
      port: element.querySelector('.port') ? Number(element.querySelector('.port').textContent) : null,
      selected: element.ariaSelected === 'true',
      dimmed: element.classList.contains('dimmed'),
      root: element.dataset.root,
    }))`)
  }

  /** Input events sent to the sidebar reach its elements only after its view has focus. */
  focusSidebar(): Promise<void> {
    return this.main(({ BaseWindow }) => {
      ;(BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.focus()
    })
  }

  /** Keys reach no view while another app is in front, and a check can wait long enough for one to come forward. */
  async toFront(): Promise<void> {
    await this.main(({ app }) => app.focus({ steal: true }))
    await until('the app in front', () => this.main(({ BaseWindow }) => BaseWindow.getAllWindows()[0].isFocused()), 3000)
  }

  /** Sends Ctrl+Tab or Ctrl+Shift+Tab to the focused view, and returns the time just before it. */
  switchTab(shift = false): Promise<number> {
    return this.main(({ webContents }, shift) => {
      const sentAt = Date.now()
      webContents.getFocusedWebContents()!.sendInputEvent({
        type: 'keyDown',
        keyCode: 'Tab',
        modifiers: shift ? ['control', 'shift'] : ['control'],
      })
      return sentAt
    }, shift)
  }

  /** Real key events to the focused view, in the order a keyboard sends them. */
  press(keys: string[]): Promise<void> {
    return this.main(({ webContents }, keys) => {
      const focused = webContents.getFocusedWebContents()!
      for (const keyCode of keys) {
        focused.sendInputEvent({ type: 'keyDown', keyCode })
        focused.sendInputEvent({ type: 'char', keyCode })
        focused.sendInputEvent({ type: 'keyUp', keyCode })
      }
    }, keys)
  }

  type(text: string): Promise<void> {
    return this.press([...text].map((character) => (character === ' ' ? 'Space' : character)))
  }

  /** A real mouse click on the middle of an element in the visible page. */
  async click(selector: string): Promise<void> {
    const point = await this.inShown<{ x: number; y: number }>(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    })()`)
    await this.main(({ webContents }, { x, y }) => {
      const focused = webContents.getFocusedWebContents()!
      focused.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      focused.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }, point)
  }

  /** Real input events to the shell view, wherever the focus is. */
  shellInput(events: unknown[]): Promise<void> {
    return this.main(({ BaseWindow }, events) => {
      const { webContents } = BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView
      for (const event of events) webContents.sendInputEvent(event as Electron.MouseInputEvent)
    }, events)
  }

  /** The path that ⌘W and the close button take. Returns the exit code. */
  async closeWindowAndWait(): Promise<number | null> {
    const exited = once(this.child, 'exit')
    void this.main(({ BaseWindow }) => void BaseWindow.getAllWindows()[0].close())
    // At exit, Node's inspector waits until the debugger disconnects.
    await sleep(100)
    this.socket.close()
    const [code] = await exited
    return code as number | null
  }

  async quit(): Promise<void> {
    this.socket.close()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit')
      this.child.kill('SIGTERM')
      await exited
    }
  }
}
