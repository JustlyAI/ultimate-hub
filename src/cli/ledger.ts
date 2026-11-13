import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UltimateError } from '../main/ultimate.ts'

/** A key whose call can have reached Ultimate, with no saved result. Only a person or a `read` can tell what happened. */
export class UnknownOutcome extends Error {}
/** A key that an earlier call used for a different command or target. */
export class KeyReused extends Error {}

/** No `result` means that the call started and did not record its end. The prompt text is never saved. */
type Entry<T> = { call: string; result?: T }

const ledgerDir = () => join(homedir(), '.ultimate-hub', 'uh', 'ledger')

/**
 * Runs `act` at most once for each key, and gives the first result to every later call with that key.
 *
 * Each key has its own file, so two calls share a file only when they share a key. The file is made before the
 * request, with a create that fails if it exists, and gets its result after the answer. A call that stops between
 * the two leaves a file with no result. `uh` then reports an unknown outcome and never sends again.
 */
export async function once<T>(key: string, call: string, act: () => Promise<T>): Promise<T> {
  const directory = ledgerDir()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  const unknown = () => new UnknownOutcome('The first call with this key did not record a result. Read the conversation, then use a new key.')
  try {
    await writeFile(path, JSON.stringify({ call } satisfies Entry<T>), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let entry: Entry<T>
    try {
      entry = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw unknown()
    }
    if (entry.call !== call) throw new KeyReused('This key was used for a different call.')
    if (entry.result === undefined) throw unknown()
    return entry.result
  }
  let result: T
  try {
    result = await act()
  } catch (error) {
    if (!(error instanceof UltimateError) || error.sent) throw new UnknownOutcome(`The request was sent, and its result is unknown: ${String(error)}`)
    await unlink(path)
    throw error
  }
  await writeFile(`${path}.tmp`, JSON.stringify({ call, result } satisfies Entry<T>), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
  return result
}
