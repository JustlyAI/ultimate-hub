import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createStatusPoller } from '../src/main/ultimate.ts'

test('a project that stops and returns on the same port is asked again at once', { timeout: 3000 }, async () => {
  let calls = 0
  const server = createServer((_request, response) => {
    calls++
    response.end('{"result":{"busy":1}}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const answers: number[] = []
  let answered = () => {}
  const poll = createStatusPoller(
    (line) => assert.fail(line),
    (command) => {
      answers.push(command.status.busy)
      answered()
    },
  )
  const answer = () => new Promise<void>((resolve) => (answered = resolve))
  try {
    let next = answer()
    poll([{ root: '/p/alpha', port }], () => undefined)
    await next
    poll([], () => undefined)
    next = answer()
    poll([{ root: '/p/alpha', port }], () => undefined)
    await next
    assert.equal(calls, 2)
    assert.deepEqual(answers, [1, 1])
  } finally {
    server.close()
  }
})

test('a project on the same port is asked again after 5 seconds, and not before', { timeout: 9000 }, async () => {
  const calls: number[] = []
  const server = createServer((_request, response) => {
    calls.push(performance.now())
    response.end('{"result":{}}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const poll = createStatusPoller(
    (line) => assert.fail(line),
    () => {},
  )
  try {
    const started = performance.now()
    while (performance.now() - started < 5600) {
      poll([{ root: '/p/alpha', port }], () => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(calls.length, 2)
    const gap = calls[1] - calls[0]
    assert.ok(gap >= 4900 && gap < 5400, `asked again after ${Math.round(gap)} ms`)
  } finally {
    server.close()
  }
})
