import type { Sheet } from '../shared/menu'

const svg = (size: number, paths: string) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const ICONS: Record<Sheet['icon'], string> = {
  play: '<path d="M6 4v16a1 1 0 0 0 1.5.86l13-8a1 1 0 0 0 0-1.72l-13-8A1 1 0 0 0 6 4z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  close: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  remove: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
}

const dialog = document.querySelector<HTMLDialogElement>('#sheet')!
const icon = dialog.querySelector<HTMLElement>('#sheet-icon')!
const title = dialog.querySelector<HTMLElement>('#sheet-title-text')!
const text = dialog.querySelector<HTMLElement>('#sheet-text')!
const path = dialog.querySelector<HTMLElement>('#sheet-path')!
const cancel = dialog.querySelector<HTMLButtonElement>('#sheet-cancel')!
const action = dialog.querySelector<HTMLButtonElement>('#sheet-action')!
dialog.querySelector('#sheet-x')!.innerHTML = svg(16, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')

/** Shows the sheet in the shell, which main has put over the whole window. Resolves true only for the action. */
export function showSheet(sheet: Sheet): Promise<boolean> {
  icon.innerHTML = svg(20, ICONS[sheet.icon])
  title.textContent = sheet.title
  text.textContent = sheet.text
  path.textContent = sheet.path ?? ''
  path.hidden = sheet.path === null
  cancel.hidden = sheet.action === null
  action.innerHTML = sheet.action === null ? '' : svg(14, ICONS[sheet.icon])
  action.append(sheet.action ?? 'OK')
  dialog.returnValue = ''
  dialog.showModal()
  // Escape, the close button, and the dimmed window answer Cancel too, so only a deliberate choice stops a server.
  ;(sheet.action === null ? action : cancel).focus()
  return new Promise((resolve) => {
    const listening = new AbortController()
    const { signal } = listening
    const answer = (value: 'action' | 'cancel' | 'ok') => dialog.close(value)
    action.addEventListener('click', () => answer(sheet.action === null ? 'ok' : 'action'), { signal })
    cancel.addEventListener('click', () => answer('cancel'), { signal })
    dialog.querySelector('#sheet-x')!.addEventListener('click', () => answer('cancel'), { signal })
    // Escape fires this. Without it, the browser closes the dialog with an empty value.
    dialog.addEventListener('cancel', () => answer('cancel'), { signal })
    // A click on the dimmed window around the panel lands on the dialog itself.
    dialog.addEventListener('click', (event) => event.target === dialog && answer('cancel'), { signal })
    dialog.addEventListener(
      'close',
      () => {
        listening.abort()
        resolve(dialog.returnValue === 'action')
      },
      { signal },
    )
  })
}
