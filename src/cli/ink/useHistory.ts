import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HISTORY_DIR = join(homedir(), '.codegrunt');
const HISTORY_FILE = join(HISTORY_DIR, 'history');
export const MAX_HISTORY = 500;

// Module-global history array — shared across all sessions in this process
export const history: string[] = [];

// ── Storage format ───────────────────────────────────────────────────────
// v0.9 and earlier: one entry per line, plain text — worked because entries
// were always single-line (paste.ts used to flatten multi-line pastes to
// spaces specifically to preserve this invariant). Now that PromptInput
// supports real multi-line entries (backslash-continuation), a plain-text
// newline-delimited file can no longer represent an entry containing '\n'
// without ambiguity. New entries are stored as JSONL (one JSON-encoded
// string per line) instead.
//
// Loading auto-detects which format each line is: a line starting with '"'
// is treated as a JSON-encoded entry; anything else is treated as a legacy
// plain-text entry (a straight passthrough — legacy entries were always
// single-line by construction, so there's nothing to decode). This means an
// old history file continues to load correctly, and mixed old/new content
// within the same file (from before an upgrade) is handled line-by-line
// rather than requiring an all-or-nothing migration pass.

function decodeHistoryLine(line: string): string | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      return typeof decoded === 'string' ? decoded : null;
    } catch {
      // Malformed JSON — fall through to treating it as legacy plain text
      // rather than dropping the entry entirely.
      return trimmed;
    }
  }
  return trimmed;
}

function encodeHistoryLine(entry: string): string {
  return JSON.stringify(entry);
}

export function loadHistory(): void {
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    const lines = raw.split('\n');
    const decoded = lines.map(decodeHistoryLine).filter((l): l is string => l !== null);
    history.push(...decoded.slice(-MAX_HISTORY));
  } catch { /* no history file yet */ }
}

export function saveHistoryEntry(line: string): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, encodeHistoryLine(line) + '\n', { flag: 'a' });
  } catch { /* ignore write errors */ }
}

loadHistory();

export interface HistoryController {
  navigateUp(currentInput: string): string;
  navigateDown(): string;
  addEntry(line: string): void;
  reset(): void;
}

export function createHistoryController(): HistoryController {
  let cursor = -1;
  let draft = '';

  return {
    navigateUp(currentInput: string): string {
      if (history.length === 0) return currentInput;
      if (cursor === -1) {
        draft = currentInput;
        cursor = history.length - 1;
      } else if (cursor > 0) {
        cursor--;
      }
      return history[cursor] ?? currentInput;
    },

    navigateDown(): string {
      if (cursor === -1) return '';
      cursor++;
      if (cursor >= history.length) {
        cursor = -1;
        return draft;
      }
      return history[cursor] ?? '';
    },

    addEntry(line: string): void {
      if (history.length === 0 || history[history.length - 1] !== line) {
        history.push(line);
        if (history.length > MAX_HISTORY) history.shift();
      }
      cursor = -1;
      draft = '';
    },

    reset(): void {
      cursor = -1;
      draft = '';
    },
  };
}

/** Exposed for tests only. */
export const __testing = { decodeHistoryLine, encodeHistoryLine, HISTORY_FILE };
