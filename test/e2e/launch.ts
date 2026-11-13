import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanEnv, isAlive, lsof, processTree, sleep, startStub, tempDir, until } from '../support/fixtures.ts'
import { BareHub } from '../support/bare.ts'
import { APP } from '../support/hub.ts'
import type { Check } from '../support/report.ts'

export async function runLaunchChecks(check: Check) {
  await check('build', 'the packaged app retains project and third-party license notices', async () => {
    const hub = await BareHub.launch(tempDir('home'), tempDir('data'))
    try {
      const names = ['LICENSE', 'THIRD_PARTY_LICENSES.md']
      const packaged = await hub.main(({ app }, names) => {
        const fs = process.getBuiltinModule('node:fs')
        const path = process.getBuiltinModule('node:path')
        return names.map((name) => fs.readFileSync(path.join(app.getAppPath(), name), 'utf8'))
      }, names)
      for (const [index, name] of names.entries())
        assert.equal(packaged[index], readFileSync(join(import.meta.dirname, '../..', name), 'utf8'), name)
      for (const name of ['xterm', 'addon-fit', 'addon-unicode-graphemes']) {
        const license = readFileSync(join(import.meta.dirname, '../../node_modules/@xterm', name, 'LICENSE'), 'utf8').trim()
        assert.ok(packaged[1].includes(license), `complete @xterm/${name} license`)
      }
      return 'The app includes the project license and all three complete xterm license notices.'
    } finally {
      await hub.quit()
    }
  })

  await check('safety', 'the packaged app opens no listening socket, with no debugger attached', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const stub = await startStub(home, join(tempDir('projects'), 'alpha'))
    const child = spawn(APP, [`--user-data-dir=${userData}`], { env: cleanEnv(home), stdio: 'ignore' })
    try {
      const pid = child.pid!
      const established = await until(
        'a page connected to the stub, which shows that lsof sees this tree',
        () => {
          const output = lsof(['-nP', '-a', `-p${processTree(pid).join(',')}`, '-iTCP', '-sTCP:ESTABLISHED', '-Fn'])
          return output.includes(`:${stub.port}`) ? output : null
        },
        15000,
      )
      await sleep(2000)
      const tree = processTree(pid)
      assert.ok(tree.length >= 4, `tree has ${tree.length} processes`)
      const listening = lsof(['-nP', '-a', `-p${tree.join(',')}`, '-iTCP', '-sTCP:LISTEN'])
      const udp = lsof(['-nP', '-a', `-p${tree.join(',')}`, '-iUDP'])
      assert.equal(listening, '', 'TCP listeners')
      assert.equal(udp, '', 'UDP sockets')
      const control = lsof(['-nP', '-a', `-p${stub.child.pid}`, '-iTCP', '-sTCP:LISTEN'])
      assert.ok(control.includes(`:${stub.port}`), 'the same query sees the listening stub')
      return `${tree.length} processes in the tree. No TCP listener and no UDP socket. Same lsof query sees the stub's listener, and ${established.split('\n').filter((line) => line.includes(String(stub.port))).length} established connection lines to it.`
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await exited
      await stub.stop()
    }
  })

  await check('safety', 'closing the window quits the app cleanly and leaves the instance running', async () => {
    const home = tempDir('home')
    const stub = await startStub(home, join(tempDir('projects'), 'alpha'))
    const results: string[] = []
    for (const delay of [0, 300, 700, 950]) {
      const hub = await BareHub.launch(home, tempDir('data'))
      await until('the tab', async () => (await hub.topRows()).length === 1, 5000)
      await sleep(delay)
      const code = await hub.closeWindowAndWait()
      assert.equal(code, 0, `exit code ${code}`)
      assert.ok(isAlive(stub.child.pid!))
      results.push(String(code))
    }
    await stub.stop()
    return `closed the window at 4 points in the scan cycle. Exit codes ${results.join(', ')}. The server process stayed alive.`
  })

  await check('safety', 'a page crash during the window close shows no error and the app exits', async () => {
    const home = tempDir('home')
    const stub = await startStub(home, join(tempDir('projects'), 'alpha'))
    const attempts = 6
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const userData = tempDir('data')
        const errors = join(userData, 'error-box.txt')
        const hub = await BareHub.launch(home, userData)
        const page = await until('the page', () =>
          hub.main(({ BaseWindow }) => {
            const [, view] = BaseWindow.getAllWindows()[0].contentView.children as Electron.WebContentsView[]
            return view?.webContents.getURL().startsWith('http') && !view.webContents.isLoading() ? view.webContents.getOSProcessId() : null
          }),
        )
        // An uncaught main process error opens a dialog, which holds the app open until someone answers it.
        await hub.main(({ dialog }, errors) => {
          dialog.showErrorBox = (title, content) => process.getBuiltinModule('node:fs').writeFileSync(errors, `${title} ${content}`)
        }, errors)
        process.kill(page, 'SIGKILL')
        const code = await Promise.race([hub.closeWindowAndWait(), sleep(6000).then(() => 'still running')])
        const shown = existsSync(errors) ? readFileSync(errors, 'utf8').split('\n')[0] : null
        await hub.quit()
        assert.equal(shown, null, `attempt ${attempt}: ${shown}`)
        assert.equal(code, 0, `attempt ${attempt}: ${code}`)
      }
      assert.ok(isAlive(stub.child.pid!))
      return `${attempts} of ${attempts} closes during a page crash exited with code 0 and showed no error`
    } finally {
      await stub.stop()
    }
  })

  await check('build', 'the packaged app runs when LaunchServices opens it, as Finder would', async () => {
    const home = tempDir('home')
    const userData = tempDir('data')
    const root = join(tempDir('projects'), 'alpha')
    const stub = await startStub(home, root)
    const bundle = APP.replace(/\/Contents\/MacOS\/.*$/, '')
    execFileSync('/usr/bin/open', ['-n', '--env', `HOME=${home}`, bundle, '--args', `--user-data-dir=${userData}`])
    const mainPid = await until('the app process', () => {
      const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      const row = rows.find((line) => line.includes(`--user-data-dir=${userData}`) && !line.includes('--type='))
      return row ? Number(row.trim().split(/\s+/)[0]) : null
    })
    try {
      const tabs = join(userData, 'tabs.json')
      await until('the app to find the instance', () => existsSync(tabs) && readFileSync(tabs, 'utf8').includes(root), 10000)
      return `pid ${mainPid} started through /usr/bin/open with the reduced launch environment, found the project through lsof, and saved it in tabs.json`
    } finally {
      process.kill(mainPid, 'SIGTERM')
      await until('the app to exit', () => !isAlive(mainPid))
      await stub.stop()
    }
  })
}
