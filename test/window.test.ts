import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBounds, placeWindow } from '../src/main/window.ts'

const laptop = { x: 0, y: 33, width: 1512, height: 877 }
const external = { x: 1512, y: 0, width: 2560, height: 1415 }
const centeredOnLaptop = { x: 56, y: 33, width: 1400, height: 877 }

test('a saved place on a display opens there', () => {
  const saved = { x: 2000, y: 200, width: 1200, height: 800 }
  assert.deepEqual(placeWindow(saved, [laptop, external], laptop), saved)
})

test('a saved place off every display opens at the default size, centered on the main display', () => {
  assert.deepEqual(placeWindow({ x: 2000, y: 200, width: 1200, height: 800 }, [laptop], laptop), centeredOnLaptop)
  assert.deepEqual(placeWindow({ x: 200, y: 2000, width: 1200, height: 800 }, [laptop], laptop), centeredOnLaptop)
})

test('no saved place opens at the default size, centered on the main display', () => {
  assert.deepEqual(placeWindow(null, [laptop, external], external), { x: 2092, y: 258, width: 1400, height: 900 })
})

test('a window partly off a display keeps its place while the left 80 points of its top row are on one', () => {
  const reachable = { x: 1432, y: 100, width: 1000, height: 600 }
  assert.deepEqual(placeWindow(reachable, [laptop], laptop), reachable)
  assert.deepEqual(placeWindow({ ...reachable, x: 1433 }, [laptop], laptop), centeredOnLaptop)
  assert.deepEqual(placeWindow({ ...reachable, x: -1 }, [laptop], laptop), centeredOnLaptop)
  assert.deepEqual(placeWindow({ ...reachable, x: 0, y: 870 }, [laptop], laptop), { ...reachable, x: 0, y: 870 })
})

test('a top row above or below the work area does not count, even if the rest of the window is on it', () => {
  assert.deepEqual(placeWindow({ x: 100, y: 10, width: 1000, height: 600 }, [laptop], laptop), centeredOnLaptop)
  assert.deepEqual(placeWindow({ x: 100, y: 900, width: 1000, height: 600 }, [laptop], laptop), centeredOnLaptop)
})

test('a saved size under the minimum grows to the minimum and keeps its place', () => {
  assert.deepEqual(placeWindow({ x: 100, y: 100, width: 300, height: 200 }, [laptop], laptop), { x: 100, y: 100, width: 700, height: 400 })
})

test('the default size shrinks to a main display smaller than it', () => {
  const small = { x: 0, y: 25, width: 1280, height: 775 }
  assert.deepEqual(placeWindow(null, [small], small), { x: 0, y: 25, width: 1280, height: 775 })
})

test('window.json must hold four whole numbers', () => {
  assert.deepEqual(parseBounds({ x: -10, y: 33, width: 900, height: 700 }), { x: -10, y: 33, width: 900, height: 700 })
  for (const bad of [null, [], {}, { x: 0, y: 0, width: 900 }, { x: '0', y: 0, width: 900, height: 700 }, { x: 0.5, y: 0, width: 900, height: 700 }])
    assert.throws(() => parseBounds(bad), /bad window bounds/)
})
