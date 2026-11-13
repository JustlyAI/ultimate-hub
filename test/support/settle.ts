/** Reads what Ultimate's status bar and error toasts show now. Warnings, such as a missing summary model, are not errors. */
export const READ_HEALTH = `(() => {
  const toasts = [...document.querySelectorAll('[role=status] [class*="bg-error"]')].map((node) => node.innerText.trim())
  return {
    origin: Math.round(performance.timeOrigin),
    toasts,
    status: (document.body.innerText.match(/\\b(live|reconnecting…|connecting…)/) ?? [])[0] ?? null,
  }
})()`

export type Health = { origin: number; toasts: string[]; status: string | null }

export const isSettled = ({ status, toasts }: Health) => status === 'live' && toasts.length === 0

export const describeHealth = ({ status, toasts }: Health) => `status ${status}, ${toasts.length} error toasts: ${toasts.join('; ')}`

/** Waits until the tab has stayed healthy for `quietMs`. Fails with what is on screen if it does not. */
export async function waitForSettled(read: () => Promise<Health>, timeoutMs = 25000, quietMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let healthySince: number | null = null
  let last: Health | null = null
  while (Date.now() < deadline) {
    try {
      last = await read()
    } catch (error) {
      // A reload in progress destroys the page's context. That is a tab that has not settled yet.
      if (!/Execution context was destroyed|navigat/i.test(String(error))) throw error
      last = null
    }
    healthySince = last && isSettled(last) ? (healthySince ?? Date.now()) : null
    if (healthySince && Date.now() - healthySince >= quietMs) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the tab did not settle: ${last ? describeHealth(last) : 'no reading'}`)
}
