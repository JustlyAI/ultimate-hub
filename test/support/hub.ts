import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { cleanEnv, sleep, until } from './fixtures.ts'

export const APP =
  process.env.HUB_APP ?? join(import.meta.dirname, '../../dist/mac-arm64/Ultimate Hub.app/Contents/MacOS/Ultimate Hub')

export type TabRow = { label: string; port: number | null; selected: boolean; dimmed: boolean; root: string }
/** A terminal view in the main process. `origin` is its page's `performance.timeOrigin`, which tells the views apart. */
export type TerminalView = { visible: boolean; focused: boolean; bounds: Electron.Rectangle; origin: number; id: number }
export type StatusSectionShown = { group: string; label: string; count: number; labels: string[]; selected?: string }
export type Shown = { pages: number; visible: { id: number; url: string; title: string; x: number; width: number }[] }
/** One part of the top list as it is on screen. Ungrouped comes last, and `header` says whether its heading shows. */
export type TopPartShown = { name: string; header: boolean; collapsed: boolean; count: number | null; marker: boolean; labels: string[] }
/** A label to click, null to close the menu with no choice, or 'real' to open the real menu and close it after 400 ms. */
export type MenuStep = string | null | 'real'
export type MenuShown = { items: { type: string; label: string; checked: boolean; enabled: boolean }[]; x?: number; y?: number; picked: string | null; opened?: boolean; closed?: boolean }
/** The button to click in the sheet: 'action' (OK on a notice) or 'cancel'. 'hold' leaves it open for `releaseSheet` or real input. */
export type SheetStep = 'action' | 'cancel' | 'hold'
/** `buttons` in screen order, `focused` is the id of the element with the keyboard, and `answer` is '' while the sheet is open. */
export type SheetShown = { title: string; text: string; path: string | null; buttons: string[]; focused: string; answer: string }
/** What the main process did to other processes, from spies on `process.kill` and `spawn`. Signal 0 is not recorded. */
export type ProcessCalls = { signals: { pid: number; signal: string }[]; spawns: { file: string; args: string[]; pid: number | undefined }[] }

export class Hub {
  private readonly app: ElectronApplication
  private readonly child: ChildProcess
  readonly userData: string

  private constructor(app: ElectronApplication, userData: string) {
    this.app = app
    this.child = app.process()
    this.userData = userData
  }

  static async launch(home: string, userData: string, env: Record<string, string> = {}): Promise<Hub> {
    const app = await _electron.launch({ executablePath: APP, args: [`--user-data-dir=${userData}`], env: cleanEnv(home, env) as Record<string, string> })
    const hub = new Hub(app, userData)
    await until('the shell', () => hub.shell().locator('#top').count())
    return hub
  }

  get pid(): number {
    return this.child.pid!
  }

  shell(): Page {
    const page = this.app.windows().find((candidate) => candidate.url().startsWith('file:') && candidate.url().endsWith('/index.html'))
    if (!page) throw new Error('no shell page')
    return page
  }

  /** The Playwright page of the view that is on screen now. */
  async shownPage(): Promise<Page> {
    const { visible } = await this.shown()
    if (visible.length !== 1) throw new Error(`${visible.length} visible pages`)
    const page = this.app.windows().find((candidate) => candidate.url() === visible[0].url)
    if (!page) throw new Error(`no page for ${visible[0].url}`)
    return page
  }

  /** The Playwright page at this address, if it is open. */
  pageAt(url: string | undefined): Page | undefined {
    return this.app.windows().find((candidate) => candidate.url() === url)
  }

  topRows(): Promise<TabRow[]> {
    return this.shell().evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#top .tab')].filter((element) => !element.closest('[hidden]')).map((element) => ({
        label: element.querySelector('.label')?.textContent ?? element.querySelector('input')?.value ?? '',
        port: element.querySelector('.port') ? Number(element.querySelector('.port')!.textContent) : null,
        selected: element.ariaSelected === 'true',
        dimmed: element.classList.contains('dimmed'),
        root: element.dataset.root!,
      })),
    )
  }

  topList(): Promise<TopPartShown[]> {
    return this.shell().evaluate(() => {
      const top = document.querySelector('#top')!
      const labels = (rows: Element[]) => rows.map((row) => row.querySelector('.label')?.textContent ?? row.querySelector('input')?.value ?? '')
      const parts = [...top.querySelectorAll(':scope > .user-group')].map((item) => {
        const header = item.querySelector('.group-header')!
        const rows = item.querySelector<HTMLElement>('.group-rows')!
        return {
          name: header.querySelector('.name')!.textContent!,
          header: true,
          collapsed: header.querySelector('.toggle')!.ariaExpanded === 'false',
          count: Number(header.querySelector('.count')!.textContent),
          marker: header.querySelector('.marker') !== null,
          labels: rows.hidden ? [] : labels([...rows.querySelectorAll('.tab')]),
        }
      })
      const ungrouped = top.querySelector(':scope > .group-header.ungrouped')
      const count = ungrouped ? Number(ungrouped.querySelector('.count')!.textContent) : null
      return [...parts, { name: 'Ungrouped', header: ungrouped !== null, collapsed: false, count, marker: false, labels: labels([...top.querySelectorAll(':scope > .tab')]) }]
    })
  }

  async topNames(): Promise<[string, string[]][]> {
    return (await this.topList()).map(({ name, labels }) => [name, labels])
  }

  /** The root of every top row in the page, also in collapsed groups. */
  topRoots(): Promise<string[]> {
    return this.shell().evaluate(() => [...document.querySelectorAll<HTMLElement>('#top .tab')].map((element) => element.dataset.root!))
  }

  groupHeader(name: string) {
    return this.shell().locator('#top .group-header', { has: this.shell().locator(`.name:text-is("${name}")`) })
  }

  focusedInShell(): Promise<string> {
    return this.shell().evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      return element?.dataset.focus ?? (element?.id || element?.tagName.toLowerCase() || '')
    })
  }

  /** Playwright cannot click a native menu, so this replaces `Menu.prototype.popup` in the main process. */
  planMenus(steps: MenuStep[]): Promise<void> {
    return this.app.evaluate(({ Menu }, steps) => {
      const holder = globalThis as unknown as { menuPlan?: { steps: MenuStep[]; shown: MenuShown[] } }
      if (!holder.menuPlan) {
        const plan = { steps: [] as MenuStep[], shown: [] as MenuShown[] }
        holder.menuPlan = plan
        const real = Menu.prototype.popup
        Menu.prototype.popup = function (this: Electron.Menu, options: Electron.PopupOptions = {}) {
          const shown: MenuShown = { items: this.items.map(({ type, label, checked, enabled }) => ({ type, label, checked, enabled })), x: options.x, y: options.y, picked: null }
          plan.shown.push(shown)
          const step = plan.steps.shift() ?? null
          if (step === 'real') {
            shown.opened = false
            shown.closed = false
            this.once('menu-will-show', () => (shown.opened = true))
            this.once('menu-will-close', () => (shown.closed = true))
            real.call(this, options)
            setTimeout(() => this.closePopup(options.window), 400)
            return
          }
          setImmediate(() => {
            const item = this.items.find(({ label }) => label === step)
            if (item) {
              shown.picked = item.label
              item.click()
            }
            options.callback?.()
          })
        }
      }
      holder.menuPlan.steps.push(...steps)
    }, steps)
  }

  menusShown(): Promise<MenuShown[]> {
    return this.app.evaluate(() => (globalThis as unknown as { menuPlan: { shown: MenuShown[] } }).menuPlan.shown)
  }

  /** Answers the real sheet in the shell with these steps, in order. With no step left, a sheet answers Cancel. */
  planSheets(steps: SheetStep[]): Promise<void> {
    return this.shell().evaluate((steps) => {
      type Plan = { steps: string[]; shown: SheetShown[] }
      const holder = window as unknown as { sheetPlan?: Plan }
      if (!holder.sheetPlan) {
        const plan: Plan = { steps: [], shown: [] }
        holder.sheetPlan = plan
        const dialog = document.querySelector<HTMLDialogElement>('#sheet')!
        const visible = (selector: string) => {
          const element = dialog.querySelector<HTMLElement>(selector)!
          return element.hidden ? null : element.textContent!
        }
        new MutationObserver(() => {
          if (!dialog.open) return
          const record: SheetShown = {
            title: dialog.querySelector('#sheet-title-text')!.textContent!,
            text: dialog.querySelector('#sheet-text')!.textContent!,
            path: visible('#sheet-path'),
            buttons: [...dialog.querySelectorAll<HTMLButtonElement>('.sheet-buttons button')].filter((button) => !button.hidden).map((button) => button.textContent!),
            focused: document.activeElement?.id ?? '',
            answer: '',
          }
          plan.shown.push(record)
          dialog.addEventListener('close', () => (record.answer = dialog.returnValue), { once: true })
          const step = plan.steps.shift() ?? 'cancel'
          if (step !== 'hold') dialog.querySelector<HTMLButtonElement>(step === 'action' ? '#sheet-action' : '#sheet-cancel')!.click()
        }).observe(dialog, { attributes: true, attributeFilter: ['open'] })
      }
      holder.sheetPlan.steps.push(...steps)
    }, steps)
  }

  /** Clicks a button of the sheet that a 'hold' step keeps open. */
  async releaseSheet(step: 'action' | 'cancel'): Promise<void> {
    await this.shell().locator(step === 'action' ? '#sheet-action' : '#sheet-cancel').click()
  }

  /** Whether the shell is the top view, over the pages and the terminal, as it is while a sheet or search is open. */
  shellOnTop(): Promise<boolean> {
    return this.app.evaluate(({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
      return views.at(-1)!.webContents.getURL().endsWith('/renderer/index.html')
    })
  }

  /** Records every signal and spawn of the main process, and still does them. */
  spyOnProcesses(): Promise<void> {
    return this.app.evaluate(() => {
      const holder = globalThis as unknown as { processCalls?: ProcessCalls }
      if (holder.processCalls) return
      const calls: ProcessCalls = { signals: [], spawns: [] }
      holder.processCalls = calls
      const realKill = process.kill.bind(process)
      process.kill = ((pid: number, signal: string | number = 'SIGTERM') => {
        if (signal !== 0) calls.signals.push({ pid, signal: String(signal) })
        return realKill(pid, signal)
      }) as typeof process.kill
      const module = process.getBuiltinModule('node:child_process') as unknown as Record<string, (...args: unknown[]) => { pid?: number }>
      const realSpawn = module.spawn
      module.spawn = (file: unknown, args: unknown, ...rest: unknown[]) => {
        const child = realSpawn(file, args, ...rest)
        calls.spawns.push({ file: String(file), args: args as string[], pid: child.pid })
        return child
      }
    })
  }

  processCalls(): Promise<ProcessCalls> {
    return this.app.evaluate(() => (globalThis as unknown as { processCalls: ProcessCalls }).processCalls)
  }

  /** Chooses Remove from Hub in the row's trailing menu (native menu stubbed). */
  async removeRow(label: string): Promise<void> {
    await this.planMenus(['Remove from Hub'])
    await this.topRow(label).locator('.row-menu').click()
  }

  sheetsShown(): Promise<SheetShown[]> {
    return this.shell().evaluate(() => (window as unknown as { sheetPlan: { shown: SheetShown[] } }).sheetPlan.shown)
  }

  statusList(): Promise<StatusSectionShown[]> {
    return this.shell().evaluate(() => {
      const found: StatusSectionShown[] = []
      for (const element of document.querySelector('#status')!.children as HTMLCollectionOf<HTMLElement>) {
        if (element.classList.contains('status-heading'))
          found.push({ group: element.dataset.kind!, label: element.firstElementChild!.textContent!, count: Number(element.querySelector('.count')!.textContent), labels: [] })
        else {
          const label = element.querySelector('.label')!.textContent!
          found.at(-1)!.labels.push(label)
          if (element.ariaSelected === 'true') found.at(-1)!.selected = label
        }
      }
      return found
    })
  }

  async groupOf(label: string): Promise<string | undefined> {
    return (await this.statusList()).find(({ labels }) => labels.includes(label))?.group
  }

  async labels(): Promise<string[]> {
    return (await this.topRows()).map((tab) => tab.label)
  }

  async tab(label: string): Promise<TabRow | undefined> {
    return (await this.topRows()).find((tab) => tab.label === label)
  }

  message(): Promise<string> {
    return this.shell().locator('#message').innerText()
  }

  topRow(label: string) {
    return this.shell().locator('#top .tab', { has: this.shell().locator(`.label:text-is("${label}")`) })
  }

  statusRow(label: string) {
    return this.shell().locator('#status .tab', { has: this.shell().locator(`.label:text-is("${label}")`) })
  }

  scrollTops(): Promise<{ top: number; status: number }> {
    return this.shell().evaluate(() => ({ top: document.querySelector('#top')!.scrollTop, status: document.querySelector('#status')!.scrollTop }))
  }

  select(label: string) {
    return this.topRow(label).click()
  }

  async rename(label: string, name: string, key: 'Enter' | 'Escape' = 'Enter') {
    await this.topRow(label).dblclick()
    const input = this.shell().locator('input.rename')
    await input.fill(name)
    await input.press(key)
  }

  drag(label: string, onto: string, half: 'top' | 'bottom') {
    return this.topRow(label).dragTo(this.topRow(onto), { targetPosition: { x: 40, y: half === 'top' ? 4 : 30 } })
  }

  /** What the user sees in the main area, from the views themselves. */
  shown(): Promise<Shown> {
    return this.app.evaluate(({ BaseWindow }) => {
      // The shell and the terminals are the views with a file: address. The shell is first, except while search is open.
      const pages = (BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]).filter((view) => !view.webContents.getURL().startsWith('file:'))
      return {
        pages: pages.length,
        visible: pages
          .filter((view) => view.getVisible())
          .map((view) => ({
            id: view.webContents.id,
            url: view.webContents.getURL(),
            title: view.webContents.getTitle(),
            x: view.getBounds().x,
            width: view.getBounds().width,
          })),
      }
    })
  }

  /** Sends a key through the browser process to the view that has focus, as the keyboard would. */
  key(keyCode: string, modifiers: string[] = []): Promise<string> {
    return this.app.evaluate(
      async ({ webContents }, [keyCode, modifiers]) => {
        const focused = webContents.getFocusedWebContents()
        if (!focused) throw new Error('no view has focus')
        const url = focused.getURL()
        focused.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as Electron.KeyboardInputEvent)
        focused.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as Electron.KeyboardInputEvent)
        return url
      },
      [keyCode, modifiers] as [string, string[]],
    )
  }

  /** Sends a key to the sidebar, the visible page, or the shown terminal, wherever macOS focus is. */
  keyTo(target: 'sidebar' | 'page' | 'terminal', keyCode: string, modifiers: string[] = []): Promise<void> {
    return this.app.evaluate(
      ({ BaseWindow }, [target, keyCode, modifiers]) => {
        const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
        const isShell = (view: Electron.WebContentsView) => view.webContents.getURL().startsWith('file:') && view.webContents.getURL().endsWith('/index.html')
        const isTerminal = (view: Electron.WebContentsView) => view.webContents.getURL().endsWith('/terminal.html')
        const view =
          target === 'sidebar' ? views.find(isShell) : views.find((other) => !isShell(other) && other.getVisible() && isTerminal(other) === (target === 'terminal'))
        if (!view) throw new Error(`no ${target} view`)
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as Electron.KeyboardInputEvent)
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as Electron.KeyboardInputEvent)
      },
      [target, keyCode, modifiers] as [string, string, string[]],
    )
  }

  focusedUrl(): Promise<string | null> {
    return this.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null)
  }

  /** Replaces the call that would open the real default browser, and records the address. */
  spyOnExternal(): Promise<void> {
    return this.app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { opened?: string[] }).opened = opened
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
  }

  /** Every terminal view, in the order the app made them. */
  terminalViews(): Promise<TerminalView[]> {
    return this.app.evaluate(({ BaseWindow }) => {
      const views = (BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]).filter((view) =>
        view.webContents.getURL().endsWith('/terminal.html'),
      )
      return Promise.all(
        views.map(async (view) => ({
          visible: view.getVisible(),
          focused: view.webContents.isFocused(),
          bounds: view.getBounds(),
          origin: Math.round(await view.webContents.executeJavaScript('performance.timeOrigin')),
          id: view.webContents.id,
        })),
      )
    })
  }

  /** The Playwright page of the terminal that the panel shows now. */
  terminalPage(): Promise<Page> {
    return until('one shown terminal and its page', async () => {
      const shown = (await this.terminalViews()).filter(({ visible }) => visible)
      if (shown.length !== 1) throw new Error(`${shown.length} visible terminals`)
      for (const page of this.app.windows())
        if (page.url().endsWith('/terminal.html') && Math.round(await page.evaluate(() => performance.timeOrigin)) === shown[0].origin) return page
      throw new Error('no page for the shown terminal')
    }, 5000)
  }

  /** Makes the next lsof calls in the main process fail, or hang until the app's own timeout kills them. */
  injectLsof(plan: { count: number; code?: number; stderr?: string; hang?: boolean }): Promise<void> {
    return this.app.evaluate((_electron, plan) => {
      const module = process.getBuiltinModule('node:child_process') as unknown as Record<string, (...args: unknown[]) => unknown>
      const holder = globalThis as unknown as { lsofPlan?: { left: number; seen: number; code: number; stderr: string; hang: boolean; real: (...args: unknown[]) => unknown } }
      if (!holder.lsofPlan) {
        const state = { left: 0, seen: 0, code: 2, stderr: '', hang: false, real: module.execFile }
        holder.lsofPlan = state
        module.execFile = (file: unknown, args: unknown, options: unknown, callback: unknown) => {
          if (!String(file).endsWith('/lsof') || state.left === 0) return state.real(file, args, options, callback)
          state.left--
          state.seen++
          if (state.hang) return state.real('/bin/sleep', ['60'], options, callback)
          const fail = callback as (error: Error, stdout: string, stderr: string) => void
          setImmediate(() => fail(Object.assign(new Error('injected lsof failure'), { code: state.code }), '', state.stderr))
          return undefined
        }
      }
      Object.assign(holder.lsofPlan, { left: plan.count, code: plan.code ?? 2, stderr: plan.stderr ?? 'injected', hang: plan.hang ?? false })
    }, plan)
  }

  /** How many lsof calls the injection has replaced. */
  lsofFailuresSeen(): Promise<number> {
    return this.app.evaluate(() => (globalThis as unknown as { lsofPlan: { seen: number } }).lsofPlan.seen)
  }

  externals(): Promise<string[]> {
    return this.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
  }

  evaluate<R, A>(fn: (electron: typeof import('electron'), arg: A) => R | Promise<R>, arg: A): Promise<R> {
    return this.app.evaluate(fn as never, arg) as Promise<R>
  }

  windowsAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  saved(): { groups: Record<string, unknown>[]; tabs: Record<string, unknown>[]; zoom: number; sidebar: string } {
    return JSON.parse(readFileSync(join(this.userData, 'tabs.json'), 'utf8'))
  }

  savedTabs(): Record<string, unknown>[] {
    return this.saved().tabs
  }

  log(): string {
    const path = join(this.userData, 'hub.log')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  /**
   * Saves what the window shows. This session has no Screen Recording permission, so `screencapture` fails. The image
   * is the window's background color with each visible view's capture drawn over it, in view order, at its real
   * position. The shell is clear, and it is on top while search is open.
   */
  async screenshot(path: string): Promise<void> {
    const parts = await this.app.evaluate(async ({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
      const capture = async (view: Electron.WebContentsView) => {
        const image = await view.webContents.capturePage()
        return { png: image.toPNG().toString('base64'), x: view.getBounds().x, y: view.getBounds().y, width: image.getSize().width, cssWidth: view.getBounds().width }
      }
      return Promise.all(views.filter((view) => view.getVisible()).map(capture))
    })
    const composite = await this.shell().evaluate(async (parts) => {
      const decode = (text: string) =>
        createImageBitmap(new Blob([Uint8Array.from(atob(text), (c) => c.charCodeAt(0))], { type: 'image/png' }))
      const bitmaps = await Promise.all(parts.map((part) => decode(part.png)))
      const canvas = new OffscreenCanvas(Math.max(...bitmaps.map(({ width }, index) => width + parts[index].x * (width / parts[index].cssWidth))), Math.max(...bitmaps.map(({ height }) => height)))
      const context = canvas.getContext('2d')!
      context.fillStyle = '#16181d'
      context.fillRect(0, 0, canvas.width, canvas.height)
      bitmaps.forEach((bitmap, index) => {
        const scale = parts[index].width / parts[index].cssWidth
        context.drawImage(bitmap, parts[index].x * scale, parts[index].y * scale)
      })
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      let text = ''
      for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192))
      return btoa(text)
    }, parts)
    writeFileSync(path, Buffer.from(composite, 'base64'))
  }

  /** For an app that a failed check left unable to quit. */
  forceStop(): void {
    if (this.windowsAlive()) this.child.kill('SIGKILL')
  }

  async quit(): Promise<void> {
    await this.app.close()
    await sleep(100)
  }
}
