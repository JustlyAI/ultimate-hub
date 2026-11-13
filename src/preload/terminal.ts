import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ready: (cols: number, rows: number) => ipcRenderer.send('terminal:ready', cols, rows),
  input: (data: string) => ipcRenderer.send('terminal:input', data),
  resize: (cols: number, rows: number) => ipcRenderer.send('terminal:resize', cols, rows),
  onData: (listener: (data: string) => void) => ipcRenderer.on('terminal:data', (_event, data) => listener(data)),
}

contextBridge.exposeInMainWorld('pty', api)

export type Pty = typeof api
