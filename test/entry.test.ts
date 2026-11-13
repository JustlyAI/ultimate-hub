import assert from 'node:assert/strict'
import { test } from 'node:test'
import { entryOf } from '../src/main/ultimate.ts'

const on = (...paths: string[]) => (path: string) => paths.includes(path)

test('the entry of `pnpm start` is a relative bin/ultimate.ts, resolved against the working directory', () => {
  assert.equal(entryOf('node bin/ultimate.ts', '/p/clone', on('/p/clone/bin/ultimate.ts')), '/p/clone/bin/ultimate.ts')
})

test('an absolute entry, also in a folder with spaces', () => {
  assert.equal(
    entryOf('node /u/my code/bin/ultimate.ts /p --no-open', '/', on('/u/my code/bin/ultimate.ts')),
    '/u/my code/bin/ultimate.ts',
  )
})

test('no entry when the script is not Ultimate or is not on disk', () => {
  assert.equal(entryOf('node mybin/ultimate.ts', '/p', () => true), null)
  assert.equal(entryOf('node bin/ultimate.ts', '/p', on()), null)
})
