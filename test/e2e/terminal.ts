import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { isAlive, lsof, sleep, startStub, tempDir, until, type Stub } from '../support/fixtures.ts'
import { Hub } from '../support/hub.ts'
import { EVIDENCE, type Check } from '../support/report.ts'

// What launchd gives an app that Finder opens. An empty LANG counts as no LANG.
const FINDER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: '' }

type Layout = {
  window: { width: number; height: number }
  page: Electron.Rectangle | null
  terminal: Electron.Rectangle | null
  split: { hidden: boolean; top: number; height: number }
  message: { bottom: number }
}

/** A shell that zsh runs with no real startup files, as the user's would run with theirs. */
function shellEnv() {
  const zdotdir = tempDir('zdot')
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(join(zdotdir, file), '')
  return { ...FINDER_ENV, SHELL: '/bin/zsh', ZDOTDIR: zdotdir }
}

const screen = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent!.replaceAll(' ', ' ').trimEnd()))

async function run(page: Page, command: string) {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

/** The last screen line that matches, as soon as one does. */
const lineMatching = (page: Page, pattern: RegExp, what: string) =>
  until(what, async () => (await screen(page)).findLast((line) => pattern.test(line))?.match(pattern) ?? null)

let token = 0
/** Runs a command whose output line starts with a new token, so that an old line never answers. */
async function ask(page: Page, command: string): Promise<string> {
  const mark = `out${++token}=`
  await run(page, `echo "${mark}$(${command})"`)
  return (await lineMatching(page, new RegExp(`^${mark}(.*)$`), command))[1]
}

function shellsOf(hub: Hub): { pid: number; cwd: string }[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, command]) => Number(ppid) === hub.pid && command.endsWith('zsh'))
    .map(([pid]) => ({ pid: Number(pid), cwd: cwdOf(Number(pid)) }))
}

const cwdOf = (pid: number) => lsof(['-a', `-p${pid}`, '-dcwd', '-Fn']).split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? ''

const layout = async (hub: Hub): Promise<Layout> => {
  const views = await hub.evaluate(({ BaseWindow }) => {
    const window = BaseWindow.getAllWindows()[0]
    const [, ...rest] = window.contentView.children as Electron.WebContentsView[]
    const shown = (terminal: boolean) => rest.find((view) => view.getVisible() && view.webContents.getURL().endsWith('/terminal.html') === terminal)?.getBounds() ?? null
    const { width, height } = window.getContentBounds()
    return { window: { width, height }, page: shown(false), terminal: shown(true) }
  }, null)
  const inShell = await hub.shell().evaluate(() => {
    const split = document.querySelector<HTMLElement>('#split')!
    const box = split.getBoundingClientRect()
    return { split: { hidden: split.hidden === true, top: box.top, height: box.height }, message: { bottom: document.querySelector('#message')!.getBoundingClientRect().bottom } }
  })
  return { ...views, ...inShell }
}

const focusedKind = async (hub: Hub) => {
  let url = await hub.focusedUrl()
  if (url === null) {
    await front(hub)
    await sleep(300)
    url = (await hub.focusedUrl()) ?? ''
  }
  return url.endsWith('/terminal.html') ? 'terminal' : url.endsWith('/index.html') ? 'sidebar' : url.startsWith('http') ? 'page' : url
}

/**
 * Other test runs on this Mac start apps that take the keyboard from this one, and then no view reports focus. Inside the
 * window, the view that had focus gets it back.
 */
const front = (hub: Hub) =>
  hub.evaluate(({ app, BaseWindow }) => {
    app.focus({ steal: true })
    BaseWindow.getAllWindows()[0].focus()
  }, null)

/** 'shell', 'page', or 'terminal' for each view, bottom first. */
const viewKinds = (hub: Hub) =>
  hub.evaluate(
    ({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].contentView.children.map((view) => {
        const url = (view as Electron.WebContentsView).webContents.getURL()
        return url.endsWith('/terminal.html') ? 'terminal' : url.startsWith('file:') ? 'shell' : 'page'
      }),
    null,
  )

const searchOpen = (hub: Hub) => hub.shell().evaluate(() => document.querySelector<HTMLDialogElement>('#search')!.open)

const visibleTerminals = async (hub: Hub) => (await hub.terminalViews()).filter(({ visible }) => visible)

const panelShown = (hub: Hub, what: string) =>
  until(what, async () => {
    if ((await focusedKind(hub)) !== 'terminal') return null
    const [shown] = await visibleTerminals(hub)
    return shown?.focused ? shown : null
  })

const panelHidden = (hub: Hub, what: string) =>
  until(what, async () => (await visibleTerminals(hub)).length === 0 && !(await layout(hub)).terminal)

const pressToggle = (hub: Hub, target: 'sidebar' | 'page', modifiers = ['control']) => hub.keyTo(target, '`', modifiers)

const pressInTerminal = (hub: Hub, key: string, modifiers: string[]) => hub.keyTo('terminal', key, modifiers)

const projectShown = (hub: Hub, root: string) =>
  until(`${root} on screen`, async () => {
    const page = await hub.shownPage().catch(() => null)
    return page && (await page.evaluate(() => document.body?.dataset.root)) === root ? page : null
  })

/** Records every form of every key that the page's own code can see. */
const listenInPage = (page: Page) =>
  page.evaluate(() => {
    const heard: string[] = []
    ;(window as unknown as { heard: string[] }).heard = heard
    for (const type of ['keydown', 'keypress', 'keyup'])
      window.addEventListener(type, (event) => heard.push(`${event.type} ${(event as KeyboardEvent).code}`), { capture: true })
  })

/** A plain key that the page must see, so that an empty result means that the key was held back and not that nothing arrived. */
async function keysHeardInPage(hub: Hub, page: Page) {
  await hub.keyTo('page', 'a')
  return until('the page hears a plain key', async () => {
    const heard = await page.evaluate(() => (window as unknown as { heard: string[] }).heard)
    return heard.includes('keyup KeyA') ? heard.filter((line) => !line.endsWith('KeyA')) : null
  })
}

/** Drags the handle by `dy` CSS pixels with real mouse events in the sidebar view. */
async function dragSplit(hub: Hub, dy: number) {
  const shell = hub.shell()
  const box = (await shell.locator('#split').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  for (let step = 1; step <= 10; step++) await shell.mouse.move(x, y + (dy * step) / 10)
  await shell.mouse.up()
}

/**
 * On macOS, ⌘C and ⌘V go through the Edit menu, which sends `copy:` or `paste:` to the focused view, and Chromium runs its
 * copy or paste command. A test cannot press the real menu, and a menu item clicked from code does nothing, so this runs
 * the same command on the shown terminal.
 */
const editCommand = (hub: Hub, command: 'copy' | 'paste') =>
  hub.evaluate(({ BaseWindow }, command) => {
    const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
    views.find((view) => view.getVisible() && view.webContents.getURL().endsWith('/terminal.html'))!.webContents[command]()
  }, command)

async function sttySize(page: Page) {
  const [rows, cols] = (await ask(page, 'stty size')).split(' ').map(Number)
  const shownRows = (await screen(page)).length
  return { rows, cols, shownRows }
}

export async function runTerminalChecks(check: Check) {
  const section = 'terminal'
  const home = tempDir('home')
  const projects = tempDir('projects')
  const names = ['alpha', 'beta two', 'gamma']
  const roots = names.map((name) => join(projects, name))
  for (const root of roots) mkdirSync(root)
  const stubs: Stub[] = []
  for (const root of roots) stubs.push(await startStub(home, root))
  const savedClipboard = { text: '' }
  const hub = await Hub.launch(home, tempDir('data'), shellEnv())
  const shot = async (name: string) => {
    await sleep(400)
    await hub.screenshot(join(EVIDENCE, name))
  }
  const pids: Record<string, number> = {}
  try {
    await until('every tab', async () => (await hub.topRows()).filter(({ dimmed }) => !dimmed).length === names.length, 5000)
    savedClipboard.text = await hub.evaluate(({ clipboard }) => clipboard.readText(), null)

    await check(section, 'Ctrl+` from a page shows the panel at one third of the window under the page, focuses the terminal, and the page does not get the key', async () => {
      const page = await projectShown(hub, roots[0])
      await listenInPage(page)
      assert.equal((await hub.terminalViews()).length, 0)
      await pressToggle(hub, 'page')
      await panelShown(hub, 'the panel with focus')
      const heard = await keysHeardInPage(hub, page)
      assert.deepEqual(heard, [], 'what the page heard of the key')
      const term = await hub.terminalPage()
      await lineMatching(term, /% $|%$/, 'a prompt')
      const { window, page: pageBox, terminal, split, message } = await layout(hub)
      assert.ok(terminal && pageBox)
      assert.equal(terminal.height, Math.round(window.height / 3))
      assert.equal(terminal.y + terminal.height, window.height)
      assert.equal(terminal.x, pageBox.x)
      assert.equal(terminal.width, pageBox.width)
      assert.equal(pageBox.y + pageBox.height + 6, terminal.y, 'a 6 px gap between the page and the panel')
      assert.equal(split.hidden, false)
      assert.equal(Math.round(split.top), pageBox.y + pageBox.height, 'the handle fills the gap')
      assert.ok(message.bottom <= terminal.y, 'the message area ends above the panel')
      await shot('terminal-01-shown.png')
      return `window ${window.width}x${window.height}. Page ${JSON.stringify(pageBox)}, gap 6 px at y ${split.top}, terminal ${JSON.stringify(terminal)}. Focus on the terminal. The page heard no form of the key.`
    })

    await check(section, 'from an app with only the system PATH and no LANG, the shell is a login zsh in the project folder, with the login PATH, TERM, and LANG', async () => {
      const term = await hub.terminalPage()
      const shells = shellsOf(hub)
      assert.equal(shells.length, 1, JSON.stringify(shells))
      assert.equal(shells[0].cwd, roots[0])
      pids.alpha = shells[0].pid
      assert.equal(await ask(term, 'echo $$'), String(pids.alpha))
      assert.equal(await ask(term, 'pwd'), roots[0])
      assert.equal(await ask(term, '[[ -o login ]] && echo login'), 'login')
      assert.equal(await ask(term, 'echo $ZSH_NAME'), 'zsh')
      assert.equal(await ask(term, 'echo $TERM'), 'xterm-256color')
      assert.equal(await ask(term, 'echo $LANG'), 'en_US.UTF-8')
      const path = await ask(term, 'echo $PATH')
      assert.notEqual(path, FINDER_ENV.PATH)
      assert.ok(path.split(':').includes('/usr/local/bin'), path)
      return `shell PID ${pids.alpha} is a child of the app (PID ${hub.pid}), cwd ${shells[0].cwd} by lsof. Login shell, TERM xterm-256color, LANG en_US.UTF-8. The app had PATH ${FINDER_ENV.PATH}, and the shell has ${path}.`
    })

    await check(section, 'Ctrl+` from the terminal hides the panel and focuses the page, which gets its full height. Ctrl+` from the sidebar shows the same shell and screen, with output from while it was hidden', async () => {
      let term = await hub.terminalPage()
      await run(term, 'echo kept-$((40+2)); (sleep 1; echo hidden-$((40+3))) &')
      await lineMatching(term, /^kept-42$/, 'the first marker')
      await pressInTerminal(hub, '`', ['control'])
      await panelHidden(hub, 'the panel to hide')
      assert.equal(await focusedKind(hub), 'page')
      const hidden = await layout(hub)
      assert.equal(hidden.page!.height, hidden.window.height)
      assert.equal(hidden.split.hidden, true)
      assert.ok(isAlive(pids.alpha))
      await sleep(1500)
      await pressToggle(hub, 'sidebar')
      await panelShown(hub, 'the panel again')
      term = await hub.terminalPage()
      await lineMatching(term, /hidden-43$/, 'the output from while hidden')
      assert.ok((await screen(term)).includes('kept-42'))
      assert.equal(await ask(term, 'echo $$'), String(pids.alpha))
      assert.equal((await hub.terminalViews()).length, 1)
      return `hidden: page height ${hidden.page!.height} of ${hidden.window.height}, handle hidden, focus on the page, PID ${pids.alpha} alive. Shown again from the sidebar: same PID, kept-42 still on screen, and hidden-43 arrived while hidden.`
    })

    await check(section, 'the terminal button in the sidebar header hides and shows the panel like Ctrl+`, and shows whether it is open', async () => {
      const button = hub.shell().locator('#terminal-toggle')
      const state = () => button.evaluate((element: HTMLButtonElement) => [element.ariaLabel, element.ariaPressed, element.disabled])
      assert.deepEqual(await state(), ['Hide terminal', 'true', false])
      await button.click()
      await panelHidden(hub, 'the panel to hide')
      assert.equal(await focusedKind(hub), 'page')
      assert.deepEqual(await state(), ['Show terminal', 'false', false])
      await button.click()
      await panelShown(hub, 'the panel again')
      assert.deepEqual(await state(), ['Hide terminal', 'true', false])
      await shot('terminal-button.png')
      return 'With the panel open, the button was Hide terminal and pressed. A click hid the panel and focused the page, and the button became Show terminal. A second click showed the panel with focus in the terminal. Screenshot terminal-button.png'
    })

    await check(section, 'Ctrl+` held down toggles once, and Ctrl+Shift, Ctrl+Alt, ⌘, and plain forms go to the page and do nothing', async () => {
      await pressInTerminal(hub, '`', ['control'])
      await panelHidden(hub, 'the panel to hide')
      const page = await projectShown(hub, roots[0])
      await listenInPage(page)
      for (const modifiers of [['control', 'shift'], ['control', 'alt'], ['meta'], []]) await pressToggle(hub, 'page', modifiers)
      const others = await keysHeardInPage(hub, page)
      assert.equal(others.filter((line) => line === 'keydown Backquote').length, 4, 'each other form reaches the page')
      assert.equal((await visibleTerminals(hub)).length, 0)
      await pressToggle(hub, 'page')
      await pressToggle(hub, 'page', ['control', 'isAutoRepeat'])
      await pressToggle(hub, 'page', ['control', 'isAutoRepeat'])
      await panelShown(hub, 'the panel after one press and two repeats')
      await sleep(400)
      assert.equal((await visibleTerminals(hub)).length, 1)
      const heard = await keysHeardInPage(hub, page)
      assert.equal(heard.filter((line) => line === 'keydown Backquote').length, 4, 'the page gets no repeat of the key')
      return 'the page heard the four other forms, and the panel stayed hidden. One press and two repeats showed the panel once, and the page heard none of them.'
    })

    await check(section, 'each tab has its own shell. Ctrl+Tab in the terminal shows the next tab\'s shell, in a folder whose name has a space, with focus. Ctrl+Shift+Tab returns to the first shell', async () => {
      await pressInTerminal(hub, 'Tab', ['control'])
      await until('beta two selected', async () => (await hub.tab('beta two'))?.selected)
      const shown = await panelShown(hub, 'the second shell with focus')
      let term = await hub.terminalPage()
      assert.equal(await ask(term, 'pwd'), roots[1])
      pids.beta = Number(await ask(term, 'echo $$'))
      assert.notEqual(pids.beta, pids.alpha)
      const shells = shellsOf(hub)
      assert.deepEqual(shells.map(({ cwd }) => cwd).sort(), [roots[0], roots[1]].sort())
      assert.equal((await hub.terminalViews()).length, 2)
      await shot('terminal-02-second-tab.png')
      await pressInTerminal(hub, 'Tab', ['control', 'shift'])
      await until('alpha selected', async () => (await hub.tab('alpha'))?.selected)
      const back = await panelShown(hub, 'the first shell with focus')
      assert.notEqual(back.id, shown.id)
      term = await hub.terminalPage()
      assert.equal(await ask(term, 'echo $$'), String(pids.alpha))
      assert.ok((await screen(term)).includes('kept-42'))
      // A real click moves focus to the sidebar view first. A synthetic click does not.
      await hub.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.focus(), null)
      await hub.select('beta two')
      await until('beta two selected by a click', async () => (await hub.tab('beta two'))?.selected)
      await until('the second shell shows', async () => (await visibleTerminals(hub))[0]?.id === shown.id)
      await until('the page has focus after a click on a row', async () => (await focusedKind(hub)) === 'page')
      return `shells ${JSON.stringify(shells)}. "beta two" has PID ${pids.beta}, and alpha kept PID ${pids.alpha} and its screen. A click on a row showed that tab's shell, and the page kept focus.`
    })

    await check(section, 'a window resize and a drag of the handle resize the panel, stty size follows, and the limits hold', async () => {
      await pressToggle(hub, 'page')
      await panelHidden(hub, 'hide')
      await pressToggle(hub, 'page')
      await panelShown(hub, 'show')
      const term = await hub.terminalPage()
      const sizes: string[] = []
      const measure = async (label: string) => {
        await sleep(300)
        const { terminal, page, window } = await layout(hub)
        const size = await sttySize(term)
        assert.equal(size.rows, size.shownRows, `${label}: stty rows match the rows on screen`)
        sizes.push(`${label}: window ${window.width}x${window.height}, panel ${terminal!.height}, page ${page!.height}, stty ${size.rows} ${size.cols}`)
        return { terminal: terminal!, page: page!, window, size }
      }
      const start = await measure('start')
      await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1000, 700), null)
      const smaller = await measure('window 1000x700')
      assert.ok(smaller.size.cols < start.size.cols && smaller.size.rows < start.size.rows)
      await dragSplit(hub, -120)
      const dragged = await measure('drag up 120')
      assert.ok(Math.abs(dragged.terminal.height - (smaller.terminal.height + 120)) <= 2, `${dragged.terminal.height}`)
      assert.ok(dragged.size.rows > smaller.size.rows)
      assert.equal(dragged.size.cols, smaller.size.cols)
      await shot('terminal-03-dragged.png')
      await dragSplit(hub, -1000)
      const top = await measure('drag to the top')
      assert.equal(top.page.height, 120, 'the page keeps 120 px')
      await dragSplit(hub, 1000)
      const bottom = await measure('drag to the bottom')
      assert.equal(bottom.terminal.height, 100, 'the panel keeps 100 px')
      await dragSplit(hub, -200)
      const kept = await measure('drag up 200')
      await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1000, 400), null)
      const short = await measure('window 1000x400')
      assert.equal(short.page.height, 120)
      assert.equal(short.terminal.height, 400 - 6 - 120)
      await hub.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1400, 900), null)
      const back = await measure('window 1400x900')
      assert.equal(back.terminal.height, kept.terminal.height, 'the dragged height returns when the window grows')
      return sizes.join('. ')
    })

    await check(section, 'a drag of the handle gives the keyboard back to the terminal or the page that had it, so typed keys reach it', async () => {
      const focusOf = () =>
        hub.evaluate(({ BaseWindow }) => {
          const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
          return views.filter((view) => view.getVisible()).map((view) => `${view.webContents.getURL().split('/').at(-1) || view.webContents.getURL()}=${view.webContents.isFocused()}`).join(' ')
        }, null)
      const pressAndDrag = async (dy: number) => {
        // A real press on the handle moves focus to the sidebar view first. A synthetic press does not.
        await hub.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0].contentView.children[0] as Electron.WebContentsView).webContents.focus(), null)
        await until('the press gives the sidebar view the keyboard', async () => (await focusedKind(hub)) === 'sidebar')
        await dragSplit(hub, dy)
      }
      const typeToFocused = async (text: string) => {
        for (const char of text)
          await hub.evaluate(({ webContents }, char) => {
            const focused = webContents.getFocusedWebContents()!
            for (const type of ['keyDown', 'char', 'keyUp'] as const) focused.sendInputEvent({ type, keyCode: char } as Electron.KeyboardInputEvent)
          }, char)
        await hub.key('Enter')
      }
      const term = await hub.terminalPage()
      await hub.evaluate(({ BaseWindow }) => {
        const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
        views.find((view) => view.getVisible() && view.webContents.getURL().endsWith('/terminal.html'))!.webContents.focus()
      }, null)
      await until('the terminal has the keyboard', async () => (await focusedKind(hub)) === 'terminal')
      await pressAndDrag(-40)
      await sleep(300)
      const afterTerminalDrag = await focusOf()
      await typeToFocused('echo dragkeys')
      const reached = await until('the keys typed after the drag reach the shell', async () => (await screen(term)).includes('dragkeys'), 3000).catch(() => false)
      assert.ok(reached, `after a drag from the terminal, the shell did not get the keys. Focus: ${afterTerminalDrag}`)

      const page = await hub.shownPage()
      await listenInPage(page)
      await hub.evaluate(({ BaseWindow }) => {
        const views = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
        views.find((view) => view.getVisible() && view.webContents.getURL().startsWith('http'))!.webContents.focus()
      }, null)
      await until('the page has the keyboard', async () => (await focusedKind(hub)) === 'page')
      await pressAndDrag(40)
      await sleep(300)
      const afterPageDrag = await focusOf()
      await hub.key('b')
      const heard = await until('the key typed after the drag reaches the page', async () => (await page.evaluate(() => (window as unknown as { heard: string[] }).heard)).includes('keyup KeyB'), 3000).catch(() => false)
      assert.ok(heard, `after a drag from the page, the page did not get the key. Focus: ${afterPageDrag}`)
      return `after a drag from the terminal: ${afterTerminalDrag}, and "echo dragkeys" typed to the focused view printed dragkeys in the shell. After a drag from the page: ${afterPageDrag}, and the page heard KeyB.`
    })

    await check(section, 'wide characters and emoji take two cells', async () => {
      const term = await hub.terminalPage()
      await run(term, 'clear')
      // \e[6n asks the terminal where its cursor is. xterm.js answers as typed input, which `read` takes.
      await run(term, `printf 'A日本B👍🏽👨‍👩‍👧\\e[6n'; read -s -d R reply; echo; echo "col${++token}=\${reply##*;}"`)
      const [, column] = await lineMatching(term, new RegExp(`^col${token}=(\\d+)$`), 'the cursor column')
      await run(term, "echo 'A日本B|👍🏽|👨‍👩‍👧|end'")
      await lineMatching(term, /^A日本B\|👍🏽\|👨‍👩‍👧\|end$/, 'the wide line')
      await shot('terminal-04-wide.png')
      assert.equal(column, '11', 'A, B, and four wide clusters fill 10 cells, so the cursor is at column 11')
      return `after A日本B👍🏽👨‍👩‍👧, xterm.js reported the cursor at column ${column} to the shell. 1+2+2+1+2+2 cells.`
    })

    await check(section, 'vim opens in the panel and quits back to the shell\'s screen', async () => {
      const term = await hub.terminalPage()
      await run(term, 'echo before-vim-$((1+1))')
      await lineMatching(term, /^before-vim-2$/, 'the marker')
      await run(term, 'vim -u NONE -N -i NONE')
      const tildes = await until('vim on screen', async () => {
        const lines = await screen(term)
        const tildes = lines.filter((line) => line.startsWith('~')).length
        return tildes >= lines.length - 3 ? tildes : null
      })
      await shot('terminal-05-vim.png')
      await term.keyboard.type(':q')
      await term.keyboard.press('Enter')
      await until('the shell screen again', async () => {
        const lines = await screen(term)
        return lines.includes('before-vim-2') && !lines.some((line) => line.startsWith('~'))
      })
      return `vim filled ${tildes} rows with ~. After :q, the shell screen came back with before-vim-2.`
    })

    await check(section, 'a paste of several lines is one bracketed paste, and copy copies the selection', async () => {
      const term = await hub.terminalPage()
      await run(term, 'clear')
      // zsh turns bracketed paste on only at its prompt, so a paste while `clear` runs would arrive as typed lines.
      await until('a clean prompt', async () => {
        const lines = (await screen(term)).filter(Boolean)
        return lines.length === 1 && lines[0].endsWith('%')
      })
      await hub.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-$((2+3))\necho pasted-$((3+3))'), null)
      await editCommand(hub, 'paste')
      await until('the pasted lines in the editor', async () => (await screen(term)).some((line) => line.endsWith('echo pasted-$((3+3))')))
      await sleep(500)
      assert.ok(!(await screen(term)).includes('pasted-5'), 'zsh did not run the first line before Enter')
      await term.keyboard.press('Enter')
      await lineMatching(term, /^pasted-6$/, 'the second output')
      assert.ok((await screen(term)).includes('pasted-5'))
      await run(term, "printf '\\e[?2004h'; cat -v")
      await sleep(300)
      await hub.evaluate(({ clipboard }) => clipboard.writeText('raw-a\nraw-b'), null)
      await editCommand(hub, 'paste')
      await term.keyboard.press('Enter')
      const raw = await lineMatching(term, /\^\[\[201~/, 'the end bracket')
      const lines = await screen(term)
      assert.ok(lines.some((line) => line.includes('^[[200~raw-a')), JSON.stringify(lines))
      await term.keyboard.press('Control+C')
      await shot('terminal-06-paste.png')
      await run(term, 'clear; echo copy-word-$((6*7))')
      await lineMatching(term, /^copy-word-42$/, 'the word to copy')
      const box = await term.evaluate(() => {
        const row = [...document.querySelectorAll('.xterm-rows > div')].find((element) => element.textContent!.replaceAll(' ', ' ').trimEnd() === 'copy-word-42')!
        const { left, top, height } = row.getBoundingClientRect()
        return { x: left + 30, y: top + height / 2 }
      })
      await hub.evaluate(({ clipboard }) => clipboard.writeText('sentinel'), null)
      await term.mouse.dblclick(box.x, box.y)
      await editCommand(hub, 'copy')
      const copied = await until('the copy', async () => {
        const text = await hub.evaluate(({ clipboard }) => clipboard.readText(), null)
        return text === 'sentinel' ? null : text
      })
      assert.equal(copied, 'copy-word-42')
      await hub.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard.text)
      return `two pasted lines waited in zsh's editor until Enter, then printed pasted-5 and pasted-6. cat -v showed ${raw[0]} after ^[[200~raw-a. A double-click and the copy command put "${copied}" on the clipboard.`
    })

    await check(section, '⌘K, ⌘W, and ⌘1 to ⌘9 do not reach the shell', async () => {
      const term = await hub.terminalPage()
      await run(term, 'clear; read -r line; echo "got[$line]"')
      await sleep(300)
      const keys = ['K', 'W', ...'123456789']
      for (const key of keys) await pressInTerminal(hub, key, ['meta'])
      for (const key of keys) await term.keyboard.press(`Meta+${key.toLowerCase()}`)
      await run(term, 'end')
      const [, got] = await lineMatching(term, /^got\[(.*)\]$/, 'the line that read got')
      assert.equal(got, 'end')
      assert.ok((await hub.tab('beta two'))?.selected, 'the selected tab did not change')
      return `the shell read "${got}" after ⌘ with ${keys.join(', ')}, sent once through sendInputEvent and once through CDP.`
    })

    await check(section, 'search: ⌘⇧F from the terminal opens search over the panel, Ctrl+` does nothing while it is open, Escape returns the keyboard to the terminal, and Enter focuses the chosen page while the panel follows', async () => {
      const [beta] = await visibleTerminals(hub)
      await pressInTerminal(hub, 'F', ['meta', 'shift'])
      const open = await until('search open over the panel, with the keyboard', async () => {
        const kinds = await viewKinds(hub)
        return (await searchOpen(hub)) && kinds.at(-1) === 'shell' && (await focusedKind(hub)) === 'sidebar' ? kinds : null
      })
      await shot('terminal-search-over-panel.png')
      await hub.key('`', ['control'])
      await sleep(300)
      assert.deepEqual((await visibleTerminals(hub)).map(({ id }) => id), [beta.id], 'Ctrl+` during search leaves the panel as it was')
      assert.equal((await viewKinds(hub)).at(-1), 'shell', 'and the shell stays on top')
      await hub.key('Escape')
      await until('search closed, the shell at the bottom, and the keyboard in the terminal', async () =>
        !(await searchOpen(hub)) && (await viewKinds(hub))[0] === 'shell' && (await focusedKind(hub)) === 'terminal',
      )
      await pressInTerminal(hub, 'F', ['meta', 'shift'])
      await until('search open again', async () => (await searchOpen(hub)) && (await focusedKind(hub)) === 'sidebar')
      await hub.shell().locator('#search-input').fill('alpha')
      await until('alpha is the active result', () => hub.shell().locator('#search-results li[aria-selected="true"][data-root$="/alpha"]').count())
      await hub.key('Enter')
      const alpha = await until('alpha selected, its page focused, and the panel on its shell', async () => {
        if ((await searchOpen(hub)) || !(await hub.tab('alpha'))?.selected || (await focusedKind(hub)) !== 'page') return null
        const shown = await visibleTerminals(hub)
        return shown.length === 1 && shown[0].id !== beta.id ? shown[0] : null
      })
      assert.equal(await ask(await hub.terminalPage(), 'echo $$'), String(pids.alpha))
      await hub.select('beta two')
      await projectShown(hub, roots[1])
      await pressToggle(hub, 'page')
      await panelHidden(hub, 'the panel to hide')
      await pressToggle(hub, 'page')
      await panelShown(hub, 'the beta shell again')
      assert.deepEqual((await visibleTerminals(hub)).map(({ id }) => id), [beta.id])
      return `views while open, bottom first: ${open.join(', ')}. Ctrl+\` changed nothing. Escape gave the keyboard back to the terminal. Enter on alpha focused its page, and the panel moved to alpha's shell, PID ${pids.alpha}, in view ${alpha.id}. Screenshot terminal-search-over-panel.png`
    })

    await check(section, 'exit hides the panel and focuses the page. The next Ctrl+` starts a new shell', async () => {
      const term = await hub.terminalPage()
      await run(term, 'exit')
      await panelHidden(hub, 'the panel to hide after exit')
      await until('the shell to end', () => !isAlive(pids.beta))
      await until('focus on the page', async () => (await focusedKind(hub)) === 'page')
      assert.equal((await hub.terminalViews()).length, 1)
      await pressToggle(hub, 'page')
      await panelShown(hub, 'a new shell')
      const pid = Number(await ask(await hub.terminalPage(), 'echo $$'))
      assert.notEqual(pid, pids.beta)
      pids.beta = pid
      return `PID ${pids.beta} replaced the shell that exited. Focus went to the page, and one terminal view remained for alpha until the new one.`
    })

    await check(section, 'a crashed terminal view ends its shell and hides the panel', async () => {
      const [shown] = await visibleTerminals(hub)
      const before = pids.beta
      await hub.evaluate(({ webContents }, id) => webContents.fromId(id)!.forcefullyCrashRenderer(), shown.id)
      await panelHidden(hub, 'the panel to hide after the crash')
      await until('the shell to end', () => !isAlive(before))
      assert.ok(isAlive(pids.alpha), 'the other shell runs')
      assert.ok(hub.windowsAlive())
      await pressToggle(hub, 'page')
      await panelShown(hub, 'a new shell after the crash')
      pids.beta = Number(await ask(await hub.terminalPage(), 'echo $$'))
      return `PID ${before} ended, alpha's PID ${pids.alpha} runs, and Ctrl+\` started PID ${pids.beta}.`
    })

    await check(section, 'an unnamed tab that leaves the list when its project stops ends its shell, and a named dimmed tab keeps it', async () => {
      await hub.rename('beta two', 'Beta')
      await until('the new name', () => hub.tab('Beta'))
      await hub.keyTo('sidebar', 'Tab', ['control'])
      await until('gamma selected', async () => (await hub.tab('gamma'))?.selected)
      const term = await hub.terminalPage()
      assert.equal(await ask(term, 'pwd'), roots[2])
      pids.gamma = Number(await ask(term, 'echo $$'))
      await hub.select('alpha')
      await until('alpha selected', async () => (await hub.tab('alpha'))?.selected)
      await stubs[2].stop()
      await stubs[1].stop()
      await until('gamma leaves the list', async () => !(await hub.tab('gamma')))
      await until('Beta dims', async () => (await hub.tab('Beta'))?.dimmed)
      await until('the gamma shell to end', () => !isAlive(pids.gamma))
      assert.ok(isAlive(pids.beta), 'the dimmed tab keeps its shell')
      assert.ok(isAlive(pids.alpha))
      await hub.select('Beta')
      await until('Beta selected', async () => (await hub.tab('Beta'))?.selected)
      await until('the Beta shell shows', async () => (await visibleTerminals(hub)).length === 1)
      assert.equal(await ask(await hub.terminalPage(), 'echo $$'), String(pids.beta))
      const { message, terminal } = await layout(hub)
      assert.equal(await hub.message(), 'Beta is not running')
      assert.ok(message.bottom <= terminal!.y)
      await shot('terminal-07-dimmed-tab.png')
      return `gamma's PID ${pids.gamma} ended when gamma left the list. The dimmed tab Beta kept PID ${pids.beta}, and its message shows above the panel.`
    })

    await check(section, 'removing a dimmed tab with Remove from Hub ends its shell', async () => {
      await hub.select('alpha')
      await until('alpha selected', async () => (await hub.tab('alpha'))?.selected)
      await hub.removeRow('Beta')
      await until('Beta leaves the list', async () => !(await hub.tab('Beta')))
      await until('the Beta shell to end', () => !isAlive(pids.beta))
      assert.equal((await hub.terminalViews()).length, 1)
      assert.ok(isAlive(pids.alpha))
      return `PID ${pids.beta} ended when Beta was removed. Alpha's PID ${pids.alpha} runs.`
    })

    await check(section, 'quitting the app ends every shell and the command that it runs', async () => {
      const term = await hub.terminalPage()
      await run(term, 'sleep 300')
      const sleeper = await until('the sleep command', () =>
        execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find(([, ppid, command]) => Number(ppid) === pids.alpha && command.endsWith('sleep'))?.[0],
      )
      const shells = shellsOf(hub).map(({ pid }) => pid)
      assert.deepEqual(shells, [pids.alpha])
      const quitAt = Date.now()
      // An exception in the main process opens a modal error box, and quit then waits for it.
      const quit = await Promise.race([hub.quit().then(() => 'quit'), sleep(5000).then(() => 'still running')])
      assert.equal(quit, 'quit', 'the app quits within 5 s')
      const quitMs = Date.now() - quitAt
      await until('every shell and its command to end', () => [...shells, Number(sleeper)].every((pid) => !isAlive(pid)), 5000)
      return `the app quit in ${quitMs} ms while the shell ran sleep. Shell ${shells.join(', ')} and its sleep ${sleeper} are gone, checked by PID.`
    })
  } finally {
    hub.forceStop()
    for (const stub of stubs) await stub.stop()
  }

  await check(section, 'with no selected tab Ctrl+` does nothing, a dimmed tab gets a shell, and a missing folder or a file logs the error and shows nothing', async () => {
    const edgeHome = tempDir('home')
    const userData = tempDir('data')
    const edgeProjects = tempDir('projects')
    const saved = join(edgeProjects, 'site')
    mkdirSync(saved)
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'tabs.json'), JSON.stringify({ groups: [], tabs: [{ root: saved, name: 'Website', groupId: null }] }))
    const edge = await Hub.launch(edgeHome, userData, shellEnv())
    const edgeStubs: Stub[] = []
    try {
      await until('the saved tab', () => edge.tab('Website'))
      assert.equal((await edge.topRows()).some(({ selected }) => selected), false)
      assert.equal(await edge.shell().locator('#terminal-toggle').isDisabled(), true, 'no tab, no terminal button')
      await pressToggle(edge, 'sidebar')
      await sleep(400)
      assert.equal((await edge.terminalViews()).length, 0)
      await edge.select('Website')
      await until('Website selected', async () => (await edge.tab('Website'))?.selected)
      assert.equal(await edge.shell().locator('#terminal-toggle').isDisabled(), false, 'a dimmed tab has a terminal button')
      await pressToggle(edge, 'sidebar')
      await panelShown(edge, 'the dimmed tab shell')
      assert.equal(await ask(await edge.terminalPage(), 'pwd'), saved)
      const [shell] = shellsOf(edge)
      await edge.removeRow('Website')
      await until('the list is empty', async () => (await edge.topRows()).length === 0)
      await panelHidden(edge, 'the panel to hide')
      await until('the shell to end', () => !isAlive(shell.pid))
      await pressToggle(edge, 'sidebar')
      await sleep(400)
      assert.equal((await edge.terminalViews()).length, 0)
      const missing = join(edgeProjects, 'missing')
      const file = join(edgeProjects, 'file')
      writeFileSync(file, '')
      for (const root of [missing, file]) edgeStubs.push(await startStub(edgeHome, root))
      await until('both tabs, one selected', async () => (await edge.topRows()).filter(({ selected }) => selected).length === 1 && (await edge.topRows()).length === 2)
      const logLine = (root: string) => until(`the line for ${root}`, () => edge.log().split('\n').find((text) => text.includes(`terminal ${root}`)))
      for (let press = 0; press < 2; press++) {
        const selected = (await edge.topRows()).find((row) => row.selected)!.root
        await pressToggle(edge, 'sidebar')
        await logLine(selected)
        await edge.keyTo('sidebar', 'Tab', ['control'])
        await until('the other tab selected', async () => (await edge.topRows()).find((row) => row.selected)!.root !== selected)
      }
      const noFolder = await logLine(missing)
      assert.ok(noFolder.includes('ENOENT'), noFolder)
      const notFolder = await logLine(file)
      assert.ok(notFolder.includes('not a folder'), notFolder)
      assert.equal((await edge.terminalViews()).length, 0)
      assert.deepEqual(shellsOf(edge), [])
      assert.ok(edge.windowsAlive())
      return `no view with one unselected saved tab or with no tabs. The dimmed Website tab got a shell in ${saved}, and its removal ended PID ${shell.pid}. Logged: ${noFolder}. Logged: ${notFolder}.`
    } finally {
      await edge.quit().catch(() => edge.forceStop())
      for (const stub of edgeStubs) await stub.stop()
    }
  })
}
