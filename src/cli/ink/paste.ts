// ── Bracketed paste handling ──────────────────────────────────────────────
//
// The bug: Ink's useInput() has no concept of paste at all — every stdin
// chunk is parsed as if it were a keypress (see node_modules/ink's
// parse-keypress.js). A normal paste that arrives in one chunk is fine (Ink
// hands the whole string to us as one call). But terminals are free to
// split a large paste across multiple stdin "data" events, and if a chunk
// boundary happens to land exactly on a '\r'/'\n' byte, that chunk is
// indistinguishable from a real Enter keypress once it reaches our handler
// (key.return is true either way) — so pasting multi-line text (a stack
// trace, a code block) could submit the message early, mid-paste.
//
// The fix: bracketed paste mode. Enabling it (PromptInput writes the
// "\x1b[?2004h" escape sequence on mount) makes well-behaved terminals wrap
// ALL pasted bytes in "\x1b[200~" ... "\x1b[201~" markers, regardless of how
// many chunks the paste itself is split into. We track our own start/end
// state here so any '\r'/'\n' arriving between those markers is buffered as
// literal paste content instead of being interpreted as Enter.
//
// Ink strips a chunk's leading ESC byte before handing the string to
// useInput callbacks (see its use-input.js — a workaround for legacy meta-key
// handling), so the marker we actually observe when it opens a chunk is
// "[200~"/"[201~" (no leading \x1b), not the raw escape sequence.

export const PASTE_START = '[200~';
export const PASTE_END = '[201~';

/** Escape sequences that toggle bracketed paste mode at the terminal level. */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export interface PasteState {
  active: boolean;
  buffer: string;
}

export const INITIAL_PASTE_STATE: PasteState = { active: false, buffer: '' };

export interface PasteChunkResult {
  state: PasteState;
  /** Set only when a complete paste was assembled on this call — insert as literal text. */
  insertText?: string;
  /** True if this chunk was paste protocol/content and must NOT also be
   *  interpreted as a normal keypress (arrow key, Enter, Ctrl+C, printable char, ...). */
  consumed: boolean;
}

/**
 * Feed one raw stdin chunk (exactly what Ink's useInput callback receives as
 * `input`) through the bracketed-paste state machine. Pure function — no I/O,
 * so it's directly unit-testable without a real TTY.
 */
export function processPasteChunk(state: PasteState, chunk: string): PasteChunkResult {
  if (!state.active) {
    const startIdx = chunk.indexOf(PASTE_START);
    if (startIdx === -1) return { state, consumed: false };

    const remainder = chunk.slice(startIdx + PASTE_START.length);
    const endIdx = remainder.indexOf(PASTE_END);
    if (endIdx === -1) {
      return { state: { active: true, buffer: remainder }, consumed: true };
    }
    return { state: INITIAL_PASTE_STATE, insertText: remainder.slice(0, endIdx), consumed: true };
  }

  const endIdx = chunk.indexOf(PASTE_END);
  if (endIdx === -1) {
    return { state: { active: true, buffer: state.buffer + chunk }, consumed: true };
  }
  return { state: INITIAL_PASTE_STATE, insertText: state.buffer + chunk.slice(0, endIdx), consumed: true };
}

/**
 * Flatten pasted text to a single line. PromptInput is a single-line input
 * (no Shift+Enter / multi-line editing exists yet), so a pasted block that
 * contains real newlines is joined with spaces rather than inserting literal
 * '\n' bytes — that keeps today's cursor-is-a-string-index model correct and
 * avoids corrupting the newline-delimited history file (~/.codegrunt/history)
 * with embedded line breaks. Runs of CR/LF collapse to one space each.
 */
export function flattenPastedText(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}
