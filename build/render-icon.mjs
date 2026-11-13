// Writes build/icon.png from build/icon.svg. From the repo root:
// fnm exec --using=26 env HOME="$(mktemp -d)" node_modules/.bin/electron build/render-icon.mjs
import { app, BrowserWindow } from 'electron'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIZE = 1024
const svg = readFileSync(join(import.meta.dirname, 'icon.svg'), 'utf8')

setTimeout(() => {
  console.error('the render did not finish in 30 seconds')
  app.exit(1)
}, 30000)

app.setPath('userData', mkdtempSync(join(tmpdir(), 'ultimate-hub-icon-')))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.dock?.hide()
// Electron holds the ready event until an ESM entry finishes, so a top-level await on it never returns.
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  })
  const contents = window.webContents
  await window.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`)}`)
  contents.invalidate()
  const [, , image] = await once(contents, 'paint')
  const { width, height } = image.getSize()
  if (width !== SIZE || height !== SIZE) throw new Error(`rendered ${width}x${height}, expected ${SIZE}x${SIZE}`)
  writeFileSync(join(import.meta.dirname, 'icon.png'), image.toPNG())
  app.exit(0)
})
