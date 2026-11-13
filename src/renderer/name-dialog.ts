import type { NameRefusal } from '../shared/tabs'

const REFUSALS: Record<NameRefusal, string> = {
  empty: 'Enter a name.',
  'too-long': 'Use 60 characters or fewer.',
  taken: 'This name is in use.',
}

const dialog = document.querySelector<HTMLDialogElement>('#name-dialog')!
const form = dialog.querySelector('form')!
const title = dialog.querySelector<HTMLElement>('#name-title')!
const input = dialog.querySelector<HTMLInputElement>('#name-input')!
const refusal = dialog.querySelector<HTMLElement>('#name-refusal')!
const cancel = dialog.querySelector<HTMLButtonElement>('#name-cancel')!
const ok = dialog.querySelector<HTMLButtonElement>('#name-ok')!

/** In the sidebar, because a page view covers everything to its right. Resolves with the trimmed name, or null on Cancel or Escape. */
export function askName(options: {
  title: string
  action: string
  initial: string
  refusalOf: (name: string) => NameRefusal | null
}): Promise<string | null> {
  title.textContent = options.title
  ok.textContent = options.action
  input.value = options.initial
  showRefusal(null)
  dialog.showModal()
  input.select()
  return new Promise((resolve) => {
    let result: string | null = null
    const listening = new AbortController()
    const { signal } = listening
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault()
        const problem = options.refusalOf(input.value)
        showRefusal(problem)
        if (problem !== null) return input.focus()
        result = input.value.trim()
        dialog.close()
      },
      { signal },
    )
    input.addEventListener('input', () => showRefusal(null), { signal })
    cancel.addEventListener('click', () => dialog.close(), { signal })
    dialog.addEventListener(
      'close',
      () => {
        listening.abort()
        resolve(result)
      },
      { signal },
    )
  })
}

function showRefusal(problem: NameRefusal | null) {
  refusal.hidden = problem === null
  refusal.textContent = problem === null ? '' : REFUSALS[problem]
  input.ariaInvalid = String(problem !== null)
}
