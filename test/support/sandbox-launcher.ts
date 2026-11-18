// A stand-in for a sandbox launcher, as docs/sandbox.md defines it. The stub server is the sandbox, so the port belongs
// to another process than the one in the lock. On SIGTERM it stops the stub, removes its lock, and exits.
// Usage: node sandbox-launcher.ts <home> <project> restart|no-restart [lock name]
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const [home, project, mode, name = basename(project)] = process.argv.slice(2)
const sandbox = fork(join(import.meta.dirname, 'stub-server.ts'), [project, '0', 'page'], { stdio: 'ignore' })
const [{ port }] = (await once(sandbox, 'message')) as [{ port: number }]
const lock = join(home, '.ultimate', 'projects', `${name}.sandbox.lock`)
const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { LC_ALL: 'C' }, encoding: 'utf8' }).trim()
const restart = mode === 'restart' ? [process.execPath, ...process.execArgv, import.meta.filename, home, project, mode, name] : undefined
mkdirSync(dirname(lock), { recursive: true })
writeFileSync(lock, JSON.stringify({ pid: process.pid, start, port, project, restart }))

process.once('SIGTERM', async () => {
  sandbox.kill('SIGTERM')
  await once(sandbox, 'exit')
  rmSync(lock, { force: true })
  process.exit(0)
})
