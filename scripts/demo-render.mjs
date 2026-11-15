// Renders the frames that scripts/demo.ts recorded into an mp4. Electron runs it: electron scripts/demo-render.mjs <shots> <out.mp4> <user data>
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [shots, out, userData] = process.argv.slice(-3)
app.setPath('userData', userData)
app.dock?.hide()

const FPS = 30
const W = 1920
const H = 1080
const WIN = { x: 200, y: 26, width: 1520, height: 950 }
const FADE = 0.35
const CLICK = 0.3

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const words = (text) => text.split(/\s+/).filter(Boolean).length

/** One output frame. Images and captions crossfade from `a` to `b` by `mix`. */
function* timeline({ window, scenes }) {
  const scale = WIN.width / window.width
  const toVideo = ({ x, y }) => ({ x: WIN.x + x * scale, y: WIN.y + y * scale })
  const frames = scenes.flatMap(({ caption, frames }) => {
    const before = frames.slice(0, -1).reduce((sum, { hold }) => sum + hold, 0)
    // Each scene stays long enough to read its caption: one second for each three words.
    const last = { ...frames.at(-1), hold: Math.max(frames.at(-1).hold, words(caption) / 3 + 0.5 - before) }
    return [...frames.slice(0, -1), last].map((frame) => ({ ...frame, caption }))
  })
  let cursor = null
  const still = (frame, extra = {}) => ({ a: frame.shot, cap: frame.caption, cursor, ...extra })
  const hold = function* (state, seconds) {
    for (let index = 0; index < Math.round(seconds * FPS); index++) yield state
  }
  const move = function* (frame, to, down) {
    const from = cursor
    const seconds = 0.3 + Math.hypot(to.x - from.x, to.y - from.y) / 1800
    const count = Math.round(seconds * FPS)
    for (let index = 1; index <= count; index++) {
      const t = easeInOut(index / count)
      cursor = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, down }
      yield still(frame)
    }
  }
  const ripple = function* (frame, down) {
    const count = Math.round(CLICK * FPS)
    for (let index = 1; index <= count; index++) yield still(frame, { cursor: { ...cursor, down, ring: index / count } })
  }

  yield* Array.from({ length: Math.round(0.6 * FPS) }, (_, index) => still(frames[0], { fade: (index + 1) / (0.6 * FPS) }))
  yield* hold(still(frames[0]), frames[0].hold)
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1]
    const frame = frames[index]
    if (frame.path) {
      const points = frame.path.map(toVideo)
      cursor ??= { x: points[0].x + 160, y: points[0].y + 120 }
      if (frame.drag) {
        yield* move(previous, points[0], false)
        yield* ripple(previous, true)
        for (const point of points.slice(1)) yield* move(previous, point, true)
        cursor = { ...cursor, down: false }
      } else {
        for (const point of points) yield* move(previous, point, false)
        yield* ripple(previous, false)
      }
    }
    if (!frame.cut) {
      const count = Math.round(FADE * FPS)
      for (let step = 1; step <= count; step++)
        yield { a: previous.shot, b: frame.shot, mix: easeInOut(step / count), cap: previous.caption, capB: frame.caption, cursor }
    }
    yield* hold(still(frame), frame.hold)
  }
  const end = frames.at(-1)
  yield* Array.from({ length: Math.round(0.8 * FPS) }, (_, index) => still(end, { fade: 1 - (index + 1) / (0.8 * FPS) }))
}

const page = (windowWidth) => `<!doctype html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas><script>
const WIN = ${JSON.stringify(WIN)}
const context = document.getElementById('c').getContext('2d')
const images = {}
window.load = async (name, url) => { images[name] = await createImageBitmap(await (await fetch(url)).blob()) }
const rounded = (x, y, w, h, r) => { context.beginPath(); context.roundRect(x, y, w, h, r) }
function caption(text, alpha) {
  if (!text || alpha <= 0) return
  context.globalAlpha = alpha
  context.fillStyle = '#e8ecf4'
  context.font = '500 34px -apple-system, "SF Pro Display", system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, ${W} / 2, (WIN.y + WIN.height + ${H}) / 2 + 2)
  context.globalAlpha = 1
}
function pointer({ x, y, down, ring }) {
  if (ring !== undefined) {
    context.strokeStyle = 'rgba(120, 160, 255,' + (1 - ring) * 0.9 + ')'
    context.lineWidth = 4
    context.beginPath(); context.arc(x, y, 8 + ring * 26, 0, Math.PI * 2); context.stroke()
  }
  const s = down ? 1.15 : 1.3
  context.save(); context.translate(x, y); context.scale(s, s)
  context.shadowColor = 'rgba(0,0,0,0.45)'; context.shadowBlur = 6; context.shadowOffsetY = 2
  context.beginPath()
  context.moveTo(0, 0); context.lineTo(0, 22); context.lineTo(5.5, 17); context.lineTo(9.5, 26); context.lineTo(13, 24.5); context.lineTo(9, 16); context.lineTo(16, 16); context.closePath()
  context.fillStyle = '#111'; context.fill()
  context.shadowColor = 'transparent'
  context.lineWidth = 1.6; context.strokeStyle = '#fff'; context.lineJoin = 'round'; context.stroke()
  context.restore()
}
window.draw = ({ a, b, mix = 0, cap, capB, cursor, fade = 1 }) => {
  const sky = context.createLinearGradient(0, 0, 0, ${H})
  sky.addColorStop(0, '#1a1f2e'); sky.addColorStop(1, '#0c0e13')
  context.fillStyle = sky; context.fillRect(0, 0, ${W}, ${H})
  context.save()
  context.shadowColor = 'rgba(0,0,0,0.55)'; context.shadowBlur = 48; context.shadowOffsetY = 16
  rounded(WIN.x, WIN.y, WIN.width, WIN.height, 14); context.fillStyle = '#16181d'; context.fill()
  context.restore()
  context.save()
  rounded(WIN.x, WIN.y, WIN.width, WIN.height, 14); context.clip()
  context.imageSmoothingQuality = 'high'
  context.drawImage(images[a], WIN.x, WIN.y, WIN.width, WIN.height)
  if (b && mix > 0) { context.globalAlpha = mix; context.drawImage(images[b], WIN.x, WIN.y, WIN.width, WIN.height); context.globalAlpha = 1 }
  const unit = WIN.width / ${windowWidth}
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
    context.beginPath(); context.arc(WIN.x + (20 + index * 20) * unit, WIN.y + 19 * unit, 6 * unit, 0, Math.PI * 2); context.fillStyle = color; context.fill()
  })
  context.restore()
  rounded(WIN.x + 0.5, WIN.y + 0.5, WIN.width - 1, WIN.height - 1, 14); context.strokeStyle = 'rgba(255,255,255,0.10)'; context.lineWidth = 1; context.stroke()
  if (capB && capB !== cap) { caption(cap, 1 - mix); caption(capB, mix) } else caption(cap, 1)
  if (cursor) pointer(cursor)
  if (fade < 1) { context.fillStyle = 'rgba(12,14,19,' + (1 - fade) + ')'; context.fillRect(0, 0, ${W}, ${H}) }
  return document.getElementById('c').toDataURL('image/png').slice(22)
}
</script></body>`

app.whenReady().then(async () => {
  const plan = JSON.parse(readFileSync(join(shots, 'timeline.json'), 'utf8'))
  const window = new BrowserWindow({ show: false, width: W, height: H, webPreferences: { backgroundThrottling: false } })
  await window.loadURL(`data:text/html,${encodeURIComponent(page(plan.window.width))}`)
  const run = (code) => window.webContents.executeJavaScript(code)
  for (const name of new Set(plan.scenes.flatMap(({ frames }) => frames.map(({ shot }) => shot))))
    await run(`load(${JSON.stringify(name)}, ${JSON.stringify(`data:image/png;base64,${readFileSync(join(shots, name)).toString('base64')}`)})`)

  const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
  let key = ''
  let png
  let count = 0
  for (const state of timeline(plan)) {
    const next = JSON.stringify(state)
    if (next !== key) {
      png = Buffer.from(await run(`draw(${next})`), 'base64')
      key = next
    }
    if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain')
    count++
  }
  ffmpeg.stdin.end()
  const [code] = await once(ffmpeg, 'exit')
  console.log(`${count} frames, ${(count / FPS).toFixed(1)} s`)
  app.exit(code ?? 1)
})
