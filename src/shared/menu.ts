export type MenuChoice = { id: string; label: string; checked?: boolean; enabled?: boolean } | { heading: string }

/** CSS pixels in the shell, which starts at the window's content origin. */
export type Point = { x: number; y: number }

/** A question in the dialog over the whole window. A null `action` makes a notice with only OK. `path` shows in a code box. */
export type Sheet = { icon: 'play' | 'pause' | 'close' | 'remove' | 'warning'; title: string; text: string; path: string | null; action: string | null }
