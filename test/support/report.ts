export const EVIDENCE = process.env.HUB_EVIDENCE ?? '/tmp/ultimate-hub-evidence'

export type Result = { section: string; name: string; status: 'pass' | 'fail'; evidence: string }
export type Check = (section: string, name: string, run: () => string | Promise<string>) => Promise<void>

export function createReport() {
  const results: Result[] = []
  const check: Check = async (section, name, run) => {
    if (process.env.HUB_ONLY && !`${section} ${name}`.includes(process.env.HUB_ONLY)) return
    const started = Date.now()
    let status: Result['status'] = 'pass'
    let evidence: string
    try {
      evidence = await run()
    } catch (error) {
      status = 'fail'
      evidence = error instanceof Error ? error.message : String(error)
      if (process.env.HUB_STACK && error instanceof Error) console.log(error.stack)
    }
    results.push({ section, name, status, evidence })
    console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} [${section}] ${name} (${Date.now() - started} ms)\n     ${evidence}`)
  }
  const table = () =>
    [
      '| Section | Check | Result | Evidence |',
      '| --- | --- | --- | --- |',
      ...results.map(
        ({ section, name, status, evidence }) =>
          `| ${section} | ${name} | ${status} | ${evidence.replaceAll('|', '/').replaceAll('\n', ' ')} |`,
      ),
    ].join('\n')
  return { results, check, table }
}
