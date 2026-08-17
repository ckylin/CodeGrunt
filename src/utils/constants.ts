import chalk from 'chalk';

// ── Theme ─────────────────────────────────────────────────────────────────
// Only the brand accent and "muted"/dim text mapping are theme-controlled.
// Semantic colors (error=red, success=green, warning=yellow) are intentionally
// NOT part of the theme — they carry meaning independent of light/dark
// preference, and changing them would make error/success harder to
// recognize at a glance for users switching themes.
//
// ACCENT/MUTED_HEX are `let` bindings (not `const`) so that applyTheme()'s
// mutation is visible to every module that imported them — ES module named
// imports are live bindings, so `import { ACCENT } from './constants.js'`
// always reads the current value, not a snapshot taken at import time.

export let ACCENT = '#4A90D9';
let mutedHex: string | null = null; // null = use chalk.gray (ANSI 8-color gray)

export function applyTheme(theme: 'dark' | 'light'): void {
  if (theme === 'light') {
    // Darker/more saturated blue — chalk's default ACCENT reads as washed-out
    // on a white terminal background. Muted text similarly needs to be a
    // concrete darker gray rather than ANSI "bright black", which some light
    // terminal themes render too close to white to read.
    ACCENT = '#1D5D96';
    mutedHex = '#5A5A5A';
  } else {
    ACCENT = '#4A90D9';
    mutedHex = null;
  }
}

/** Theme-aware "muted"/secondary-text color. Use this instead of a local
 *  `chalk.gray` alias so /theme actually affects every screen, not just the
 *  ones that happen to import ACCENT already. */
export function muted(s: string): string {
  return mutedHex ? chalk.hex(mutedHex)(s) : chalk.gray(s);
}
