import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { BaseWindow, Rectangle } from 'electron'
import { RAIL_WIDTH } from '../shared/tabs.ts'

const DEFAULT_SIZE = { width: 1400, height: 900 }
export const MIN_SIZE = { width: 700, height: 400 }
// The user moves the window by the sidebar's top row, which holds the window buttons. The place counts only if the
// part of that row that the rail keeps is on a display.
const DRAG_ROW = { width: RAIL_WIDTH, height: 40 }
const SAVE_DELAY_MS = 500

function overlap(a: Rectangle, b: Rectangle): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/** The saved place if its drag row is on a display, or the default size centered in the main display's work area. */
export function placeWindow(saved: Rectangle | null, workAreas: readonly Rectangle[], main: Rectangle): Rectangle {
  if (saved) {
    const bounds = { ...saved, width: Math.max(saved.width, MIN_SIZE.width), height: Math.max(saved.height, MIN_SIZE.height) }
    const row = { x: bounds.x, y: bounds.y, ...DRAG_ROW }
    const onDisplay = workAreas.some((area) => {
      const { width, height } = overlap(row, area)
      return width >= DRAG_ROW.width && height >= DRAG_ROW.height
    })
    if (onDisplay) return bounds
  }
  const width = Math.min(DEFAULT_SIZE.width, main.width)
  const height = Math.min(DEFAULT_SIZE.height, main.height)
  return { x: main.x + Math.round((main.width - width) / 2), y: main.y + Math.round((main.height - height) / 2), width, height }
}

export function parseBounds(value: unknown): Rectangle {
  const { x, y, width, height } = (value ?? {}) as Partial<Rectangle>
  if (![x, y, width, height].every(Number.isInteger)) throw new Error(`bad window bounds: ${JSON.stringify(value)}`)
  return { x: x!, y: y!, width: width!, height: height! }
}

export function loadBounds(path: string, log: (line: string) => void): Rectangle | null {
  try {
    return parseBounds(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`window.json: ${String(error)}`)
    return null
  }
}

/** Saves the normal bounds soon after each move or resize, so a crash keeps the last place, and again at close. */
export function rememberBounds(window: BaseWindow, path: string, log: (line: string) => void): void {
  let timer: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(timer)
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(window.getNormalBounds()))
      renameSync(`${path}.tmp`, path)
    } catch (error) {
      log(`window.json: ${String(error)}`)
    }
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }
  window.on('move', later)
  window.on('resize', later)
  window.on('close', save)
}
