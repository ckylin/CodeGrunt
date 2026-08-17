// ── Simple Output Pager ──────────────────────────────────────────────────────
// /help, /sessions, and /memory can all produce more lines than fit in one
// terminal screen. Before this, they just dumped everything via console.log
// and the top scrolled off before the user could read it. printPaged() holds
// back everything past the first screenful behind a "-- more --" prompt,
// advancing one page per keypress — the standard `less`/`more` interaction,
// scoped down to what a CLI actually needs (no search, no scrollback).

import { muted } from './constants.js';

const MORE_PROMPT_TEXT = '-- more (press any key, q to quit) --';
const MORE_PROMPT = muted(MORE_PROMPT_TEXT);

/** Reads exactly one raw keypress from stdin and resolves with it.
 *  Restores the previous raw-mode state on exit — mirrors the save/restore
 *  pattern in utils/interrupt.ts so nested raw-mode users don't clobber
 *  each other's state. */
function readOneKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    const onData = (chunk: Buffer | string): void => {
      stdin.removeListener('data', onData);
      if (!wasRaw) {
        try { stdin.setRawMode?.(false); } catch { /* best-effort */ }
        stdin.pause();
      }
      resolve(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };
    try {
      if (!wasRaw) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.once('data', onData);
    } catch {
      // Raw mode unavailable — resolve immediately so the pager falls back
      // to printing everything rather than hanging forever waiting for a
      // keypress that can never be captured (see interrupt.ts for the same
      // Windows-terminal-context concern).
      resolve('');
    }
  });
}

/** Splits into terminal-width-independent lines (rows only, no column wrap —
 *  each caller's content already wraps or is short enough not to need it). */
function splitLines(text: string): string[] {
  return text.split('\n');
}

export interface PrintPagedOptions {
  /** Override terminal rows for testing. Defaults to process.stdout.rows. */
  rows?: number;
  /** Override the TTY check for testing. */
  isTTY?: boolean;
}

/**
 * Prints `text` to stdout, pausing behind a "-- more --" prompt once the
 * content exceeds one screen. Falls back to printing everything at once
 * when stdout isn't a TTY (piped output, CI, non-interactive) since there's
 * no one to press a key and no benefit to withholding the tail.
 */
export async function printPaged(text: string, options: PrintPagedOptions = {}): Promise<void> {
  const isTTY = options.isTTY ?? process.stdout.isTTY ?? false;
  if (!isTTY) {
    process.stdout.write(text + '\n');
    return;
  }

  const lines = splitLines(text);
  const rows = options.rows ?? process.stdout.rows ?? 24;
  // Reserve one row for the "-- more --" prompt itself.
  const pageSize = Math.max(1, rows - 1);

  if (lines.length <= pageSize) {
    process.stdout.write(text + '\n');
    return;
  }

  for (let i = 0; i < lines.length; i += pageSize) {
    const page = lines.slice(i, i + pageSize);
    process.stdout.write(page.join('\n') + '\n');

    const isLastPage = i + pageSize >= lines.length;
    if (isLastPage) break;

    process.stdout.write(MORE_PROMPT);
    const key = await readOneKey();
    // Clear the prompt line before printing the next page.
    process.stdout.write('\r' + ' '.repeat(MORE_PROMPT_TEXT.length) + '\r');
    if (key === 'q' || key === 'Q' || key === '\x03' || key === '\x1b') {
      break;
    }
  }
}
