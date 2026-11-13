import { contextBridge, ipcRenderer } from 'electron'
import type { MenuChoice, Point, Sheet } from '../shared/menu'
import type { Command, LifecycleAction, MainArea, Sidebar } from '../shared/tabs'

const api = {
  send: (command: Command) => ipcRenderer.send('command', command),
  onState: (listener: (sidebar: Sidebar, main: MainArea) => void) =>
    ipcRenderer.on('state', (_event, sidebar, main) => listener(sidebar, main)),
  /** Shows a native menu at `at`. Resolves with the chosen id, or null when the menu closes with no choice. */
  pick: (items: MenuChoice[], at: Point): Promise<string | null> => ipcRenderer.invoke('pick', items, at),
  /** Asks in the dialog over the whole window. Resolves true only for the action. */
  ask: (sheet: Sheet): Promise<boolean> => ipcRenderer.invoke('ask', sheet),
  /** Main puts the shell over the pages before it sends a sheet, and puts it back after `answerSheet`. */
  onSheet: (listener: (sheet: Sheet) => void) => ipcRenderer.on('sheet', (_event, sheet) => listener(sheet)),
  answerSheet: (yes: boolean) => ipcRenderer.send('sheet-answer', yes),
  /** `fromPage` is true when a page or a terminal had the keyboard, so main returns focus to it. */
  onSearch: (listener: (fromPage: boolean) => void) => ipcRenderer.on('search', (_event, fromPage) => listener(fromPage)),
  openSearch: () => ipcRenderer.send('open-search'),
  /** Shows or hides the selected tab's shell, as Ctrl+` does. */
  toggleTerminal: () => ipcRenderer.send('toggle-terminal'),
  /** Opens the folder picker. Resolves whether a folder was chosen. */
  addUltimate: (): Promise<boolean> => ipcRenderer.invoke('add-ultimate'),
  /** Resolves false, and search stays open, if `root` is no longer live. */
  closeSearch: (root: string | null): Promise<boolean> => ipcRenderer.invoke('close-search', root),
  /** The terminal panel's height in CSS pixels, or 0 when it is hidden. */
  onPanel: (listener: (height: number) => void) => ipcRenderer.on('panel', (_event, height) => listener(height)),
  resizePanel: (height: number) => ipcRenderer.send('panel-height', height),
  endPanelDrag: () => ipcRenderer.send('panel-drag-end'),
  /** Asks the main process to pause, start, or close the Ultimate of this root. It checks, confirms, and acts on its own. */
  lifecycle: (root: string, action: LifecycleAction) => ipcRenderer.send('lifecycle', root, action),
}

contextBridge.exposeInMainWorld('hub', api)

export type Hub = typeof api
