/// <reference types="vite/client" />
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Terminal } from '@xterm/xterm'
import type { Pty } from '../preload/terminal'

declare const pty: Pty

const element = document.querySelector<HTMLElement>('#terminal')!
const terminal = new Terminal({
  allowProposedApi: true,
  fontFamily: 'Menlo, monospace',
  fontSize: 13,
  scrollback: 10000,
  theme: { background: '#101114', foreground: '#d7dae0', cursor: '#d7dae0' },
})
const fit = new FitAddon()
terminal.loadAddon(fit)
// Without it, an emoji with a modifier or a joiner takes the wrong number of cells.
terminal.loadAddon(new UnicodeGraphemesAddon())
terminal.unicode.activeVersion = '15-graphemes'
terminal.open(element)
fit.fit()

terminal.onData((data) => pty.input(data))
terminal.onResize(({ cols, rows }) => pty.resize(cols, rows))
pty.onData((data) => terminal.write(data))
new ResizeObserver(() => fit.fit()).observe(element)
pty.ready(terminal.cols, terminal.rows)
terminal.focus()
