import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const inputs = (folder: string, files: Record<string, string>) => ({
  build: { rollupOptions: { input: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, resolve(folder, file)])) } },
})

export default defineConfig({
  main: {},
  preload: inputs('src/preload', { index: 'index.ts', terminal: 'terminal.ts' }),
  renderer: inputs('src/renderer', { index: 'index.html', terminal: 'terminal.html' }),
})
