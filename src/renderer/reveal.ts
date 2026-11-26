const heightIn = (box: DOMRect, row: HTMLElement) => {
  const { top, bottom } = row.getBoundingClientRect()
  return Math.max(0, Math.min(bottom, box.bottom) - Math.max(top, box.top))
}

/**
 * Scrolls `list` the least that shows one of these rows of one tab, in list order. A favorite has two: its copy in
 * Favorites, then the row in its own place. The one with more of it on screen wins, so the list does not leave a row
 * that the user can see. On a tie, as with neither on screen, the row in its own place wins. False if no row shows.
 */
export function reveal(list: HTMLElement, rows: Iterable<HTMLElement>): boolean {
  const box = list.getBoundingClientRect()
  let best: HTMLElement | undefined
  for (const row of rows) {
    if (!row.closest('[hidden]') && (!best || heightIn(box, row) >= heightIn(box, best))) best = row
  }
  best?.scrollIntoView({ block: 'nearest' })
  return best !== undefined
}
