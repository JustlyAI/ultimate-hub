// Drives the real packaged app. Run with Node 26: node scripts/verify.ts [rules] [groups] [real] [scale] [launch] [zoom] [search] [terminal] [lifecycle] [window] [sidebar] [add]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runLaunchChecks } from '../test/e2e/launch.ts'
import { runLifecycleChecks } from '../test/e2e/lifecycle.ts'
import { runRealChecks } from '../test/e2e/real.ts'
import { runAddChecks } from '../test/e2e/add.ts'
import { runGroupChecks } from '../test/e2e/groups.ts'
import { runRuleChecks } from '../test/e2e/rules.ts'
import { runScaleChecks, runScaleStatusCheck } from '../test/e2e/scale.ts'
import { runSearchChecks } from '../test/e2e/search.ts'
import { runSidebarChecks } from '../test/e2e/sidebar.ts'
import { runTerminalChecks } from '../test/e2e/terminal.ts'
import { runRealStatusChecks, runStubStatusChecks } from '../test/e2e/status.ts'
import { runWindowChecks } from '../test/e2e/window.ts'
import { runZoomChecks } from '../test/e2e/zoom.ts'
import { cleanUp, CLONE, namesThisRun, stillRunning } from '../test/support/fixtures.ts'
import { createReport, EVIDENCE } from '../test/support/report.ts'

const modified = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : null)

// Electron finds the user data folder from the account, not from HOME, so an app started without --user-data-dir uses the real one.
const homeState = () => ({
  ultimate: existsSync(join(homedir(), '.ultimate')),
  piModified: modified(join(homedir(), '.pi')),
  hubDataModified: modified(join(homedir(), 'Library/Application Support/Ultimate Hub')),
})

const chosen = process.argv.slice(2)
const wants = (section: string) => chosen.length === 0 || chosen.includes(section)

mkdirSync(EVIDENCE, { recursive: true })
const report = createReport()
const homeBefore = homeState()

try {
  if (wants('rules')) {
    await runRuleChecks(report.check)
    await runStubStatusChecks(report.check)
  }
  if (wants('rules') || chosen.includes('groups')) await runGroupChecks(report.check)
  if (wants('launch')) await runLaunchChecks(report.check)
  if (wants('window')) await runWindowChecks(report.check)
  if (wants('zoom')) await runZoomChecks(report.check)
  if (wants('sidebar')) await runSidebarChecks(report.check)
  if (wants('terminal')) await runTerminalChecks(report.check)
  if (wants('real')) {
    await runRealChecks(report.check)
    await runRealStatusChecks(report.check)
  }
  if (wants('scale')) {
    await runScaleChecks(report.check)
    await runScaleStatusCheck(report.check)
  }
  if (wants('search')) await runSearchChecks(report.check)
  if (wants('lifecycle')) await runLifecycleChecks(report.check)
  if (wants('add')) await runAddChecks(report.check)
} finally {
  await report.check('safety', 'the Ultimate clone stays unmodified', () => {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: CLONE, encoding: 'utf8' })
    if (status.trim()) throw new Error(`git status: ${status}`)
    return 'git status --porcelain is empty'
  })
  await report.check('safety', 'the real ~/.ultimate, ~/.pi, and Hub user data folder are not touched', () => {
    assert.deepEqual(homeState(), homeBefore)
    return `folder metadata only, not contents, before and after: ${JSON.stringify(homeBefore)}`
  })
  await cleanUp()
  await report.check('cleanup', 'no process of this run remains', () => {
    if (stillRunning().length) throw new Error(`${stillRunning().length} children still run`)
    // Sibling runs in other worktrees use the same clone and folder prefix, so only this run's folders count.
    const ps = execFileSync('/bin/ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const left = ps.split('\n').filter(namesThisRun)
    if (left.length) throw new Error(left.map((line) => line.slice(0, 300)).join('\n'))
    return 'ps shows no process that names a temporary folder of this run in its arguments or its environment'
  })
  writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify(report.results, null, 2))
  writeFileSync(join(EVIDENCE, 'results.md'), report.table())
  console.log(`\n${report.table()}`)
  process.exitCode = report.results.some(({ status }) => status === 'fail') ? 1 : 0
}
