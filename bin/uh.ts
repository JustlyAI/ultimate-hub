#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
import { text } from 'node:stream/consumers'
import { run } from '../src/cli/uh.ts'

const output = await run(process.argv.slice(2), () => text(process.stdin))
process.exitCode = output.ok ? 0 : 1
process.stdout.write(`${JSON.stringify(output)}\n`)
