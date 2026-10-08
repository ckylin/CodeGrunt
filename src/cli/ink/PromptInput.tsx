import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { accessSync } from 'fs';
import { join } from 'path';
import { ACCENT } from '../../utils/constants.js';
import { Dropdown } from './Dropdown.js';
import { useTerminalSize } from './useTerminalSize.js';
import {
  lineStart, lineEnd, cursorLineIndex, moveVertical, wordLeft, wordRight,
  deleteWordBefore, deleteToLineStart, deleteToLineEnd,
  visibleWindow, maxInputRows, buildRule,
} from './editing.js';
import { createHistoryController, saveHistoryEntry } from './useHistory.js';
import { getAutocompleteItems, findAtTokenAtCursor } from './useAutocomplete.js';
import {
  processPasteChunk, normalizePastedText, INITIAL_PASTE_STATE,
  ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE,
} from './paste.js';
import type { PromptInputProps } from './types.js';

function detectContextFile(cwd: string): string | null {
  for (const name of ['CODEGRUNT.md', 'CLAUDE.md']) {
    try { accessSync(join(cwd, name)); return name; } catch { /* not found */ }
  }
  return null;
}

export function PromptInput({
  cwd,
  model,
  skills,
  activeSkill,
  showMeta,
  onSubmit,
  busy = false,
  onCancelBusy,
}: PromptInputProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [exitHint, setExitHint] = useState(false);
  // True right after recalling a history entry — suppresses the dropdown so
  // that a recalled "/foo" or "@bar" line doesn't hijack the next up/down
  // press (which the user expects to keep navigating history, not a menu).
  // Cleared as soon as the user actively edits the text again.
  const [suppressDropdown, setSuppressDropdown] = useState(false);
  const historyCtrl = useRef(createHistoryController());
  // Refs mirror state so useInput callbacks always read the latest values.
  // Updated synchronously in the handler (not via useEffect) so rapid keypresses
  // never see stale values between React renders.
  const inputRef = useRef('');
  const cursorRef = useRef(0);
  const lastCtrlCRef = useRef(0);
  const suppressDropdownRef = useRef(false);
  // Bracketed-paste assembly state — see paste.ts for why this exists (a
  // multi-line paste split across stdin chunks could otherwise submit early
  // on an embedded newline). Held in a ref, not state: it's pure plumbing
  // for a single event handler pass and never needs to trigger a re-render.
  const pasteStateRef = useRef(INITIAL_PASTE_STATE);

  // Tell the terminal to wrap pastes in \x1b[200~ / \x1b[201~ markers so
  // multi-line paste content never gets misread as an Enter keypress.
  // Symmetric disable on unmount — PromptInput remounts fresh every turn
  // (readMultilineInput renders a new tree each call), and paste mode is a
  // terminal-wide toggle that must not stay on while nothing is listening
  // for the markers (e.g. mid agent-run, when this component is unmounted).
  useEffect(() => {
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    return () => { process.stdout.write(DISABLE_BRACKETED_PASTE); };
  }, []);

  const apply = (nextInput: string, nextCursor: number) => {
    inputRef.current = nextInput;
    cursorRef.current = nextCursor;
    setInput(nextInput);
    setCursor(nextCursor);
  };

  const moveCursor = (next: number) => {
    cursorRef.current = next;
    setCursor(next);
  };

  const setSuppress = (value: boolean) => {
    suppressDropdownRef.current = value;
    setSuppressDropdown(value);
  };

  const dropdownItems = suppressDropdown ? [] : getAutocompleteItems(input, cursor, cwd, skills);
  const dropdownVisible = dropdownItems.length > 0;

  // Reset dropdown selection when items change
  useEffect(() => {
    setDropdownIndex(0);
  }, [input, cursor]);

  // For '@' file completions, replace only the @token under the cursor
  // (not the whole line) so multiple @-references can coexist. Slash
  // commands/skills still replace the whole input, as before.
  const acceptSelection = (selected: { value: string; kind?: 'builtin' | 'skill' | 'file' }) => {
    if (selected.kind === 'file') {
      const match = findAtTokenAtCursor(inputRef.current, cursorRef.current);
      if (match) {
        // A directory suggestion ends in '/' — the user is meant to keep typing
        // to narrow down into it, so don't shove a space in their way. A file
        // suggestion is a complete token — append a trailing space (unless one
        // is already there) so the next typed character doesn't run into it.
        const isDir = selected.value.endsWith('/');
        const alreadySpaced = inputRef.current[match.end] === ' ';
        const insertion = (!isDir && !alreadySpaced) ? selected.value + ' ' : selected.value;
        const next = inputRef.current.slice(0, match.start) + insertion + inputRef.current.slice(match.end);
        apply(next, match.start + insertion.length);
        return;
      }
    }
    apply(selected.value, selected.value.length);
  };

  useInput((char, key) => {
    const cur = cursorRef.current;
    const inp = inputRef.current;

    // While busy (an agent turn is running), the input stays mounted and
    // visible (dimmed — see the render below) instead of unmounting, but it
    // does not accept new submissions or edits: there's no message queue
    // for a second task to wait behind the first, so accepting a typed-ahead
    // message here would just silently discard it. Esc/Ctrl+C are the only
    // live keys — they interrupt the RUNNING turn.
    if (busy) {
      if (key.escape || (key.ctrl && char === 'c')) onCancelBusy?.();
      return;
    }

    // ── Bracketed paste ──────────────────────────────────────────────────
    // Must run before any other handling: a paste containing an embedded
    // newline arrives as a chunk that key.return would otherwise treat as
    // Enter (see paste.ts for the full explanation). Once inside an active
    // paste, EVERY chunk is paste content until the end marker shows up —
    // including chunks that would otherwise look like arrow keys or Ctrl+C,
    // since those byte sequences can legitimately occur inside pasted text.
    if (pasteStateRef.current.active || char.includes('[200~')) {
      const result = processPasteChunk(pasteStateRef.current, char);
      pasteStateRef.current = result.state;
      if (result.consumed) {
        if (result.insertText !== undefined) {
          const normalized = normalizePastedText(result.insertText);
          apply(inp.slice(0, cur) + normalized + inp.slice(cur), cur + normalized.length);
        }
        return;
      }
    }

    // Any key other than up/down means the user is actively editing again —
    // stop suppressing the dropdown so '@'/'/' autocomplete works normally.
    if (suppressDropdownRef.current && !key.upArrow && !key.downArrow) {
      setSuppress(false);
    }

    // Ctrl+C → double-press within 2s to exit
    if (key.ctrl && char === 'c') {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) {
        onSubmit({ text: '', cancelled: true });
      } else {
        lastCtrlCRef.current = now;
        setExitHint(true);
        // Auto-hide hint after 2s so it disappears if user doesn't press again
        setTimeout(() => setExitHint(false), 2000);
      }
      return;
    }

    // Word jumps: Alt/Ctrl+Left/Right (modified arrows) and Alt+b / Alt+f
    // (what macOS terminals send for Option+arrow).
    if (key.leftArrow && (key.meta || key.ctrl)) { moveCursor(wordLeft(inp, cur)); return; }
    if (key.rightArrow && (key.meta || key.ctrl)) { moveCursor(wordRight(inp, cur)); return; }
    if (key.meta && char === 'b') { moveCursor(wordLeft(inp, cur)); return; }
    if (key.meta && char === 'f') { moveCursor(wordRight(inp, cur)); return; }

    // Left arrow — move cursor left
    if (key.leftArrow) {
      moveCursor(Math.max(0, cur - 1));
      return;
    }

    // Right arrow — move cursor right
    if (key.rightArrow) {
      moveCursor(Math.min(inp.length, cur + 1));
      return;
    }

    // Arrow up — dropdown, else the previous line of a multi-line entry,
    // else older history (only from the first line, like a shell).
    if (key.upArrow) {
      if (dropdownVisible && !suppressDropdownRef.current) {
        setDropdownIndex(i => (i <= 0 ? dropdownItems.length - 1 : i - 1));
        return;
      }
      const up = moveVertical(inp, cur, -1);
      if (up !== null) {
        moveCursor(up);
        return;
      }
      const prev = historyCtrl.current.navigateUp(inp);
      apply(prev, prev.length);
      // Recalled text may itself start with '/' or contain '@' — don't let
      // it pop the dropdown and steal the next up/down press.
      setSuppress(true);
      return;
    }

    // Arrow down — mirror of up: dropdown, next line, then newer history.
    if (key.downArrow) {
      if (dropdownVisible && !suppressDropdownRef.current) {
        setDropdownIndex(i => (i >= dropdownItems.length - 1 ? 0 : i + 1));
        return;
      }
      const down = moveVertical(inp, cur, 1);
      if (down !== null) {
        moveCursor(down);
        return;
      }
      const next = historyCtrl.current.navigateDown();
      apply(next, next.length);
      setSuppress(true);
      return;
    }

    // Tab — accept dropdown selection if open
    if (key.tab) {
      if (dropdownVisible) {
        const selected = dropdownItems[dropdownIndex];
        if (selected) acceptSelection(selected);
      }
      return;
    }

    // Escape — dismiss the dropdown first (without touching what's typed),
    // and only clear the whole input if there's no dropdown open. Wiping a
    // half-typed message just to back out of an autocomplete menu is exactly
    // the kind of surprise that makes a slash-command flow feel unreliable.
    if (key.escape) {
      if (dropdownVisible) {
        setSuppress(true);
        return;
      }
      apply('', 0);
      return;
    }

    // Enter — accept dropdown, insert a newline (backslash-continuation), or submit
    if (key.return) {
      if (dropdownVisible && dropdownItems.length > 0) {
        const selected = dropdownItems[dropdownIndex];
        if (selected) {
          if (selected.kind !== 'file') {
            const trimmed = selected.value.trim();
            historyCtrl.current.addEntry(trimmed);
            saveHistoryEntry(trimmed);
            onSubmit({ text: trimmed, cancelled: false });
          } else {
            acceptSelection(selected);
          }
        }
        return;
      }

      // Backslash-continuation, matching Aider/many REPLs: a line ending in
      // '\' right before the cursor means "insert a newline, don't submit
      // yet" rather than "send this message". The trailing backslash is
      // removed so it never ends up as literal content in the sent message.
      // Chosen over Shift+Enter because Shift+Enter has no universal,
      // terminal-independent byte signal — Ink's own keypress parser can't
      // reliably distinguish it from plain Enter without extra
      // terminal-specific protocol support that only some emulators speak.
      if (cur > 0 && inp[cur - 1] === '\\') {
        const next = inp.slice(0, cur - 1) + '\n' + inp.slice(cur);
        apply(next, cur);
        return;
      }

      const trimmed = inp.trim();
      if (!trimmed) return;
      historyCtrl.current.addEntry(trimmed);
      saveHistoryEntry(trimmed);
      onSubmit({ text: trimmed, cancelled: false });
      return;
    }

    // Ctrl+A / Ctrl+E — start / end of the current line (the whole input when single-line)
    if (key.ctrl && char === 'a') { moveCursor(lineStart(inp, cur)); return; }
    if (key.ctrl && char === 'e') { moveCursor(lineEnd(inp, cur)); return; }

    // Ctrl+W / Alt+Backspace — delete the word before the cursor
    if ((key.ctrl && char === 'w') || ((key.backspace || key.delete) && key.meta)) {
      const r = deleteWordBefore(inp, cur);
      apply(r.text, r.cursor);
      return;
    }

    // Ctrl+U / Ctrl+K — delete to line start / line end
    if (key.ctrl && char === 'u') {
      const r = deleteToLineStart(inp, cur);
      apply(r.text, r.cursor);
      return;
    }
    if (key.ctrl && char === 'k') {
      const r = deleteToLineEnd(inp, cur);
      apply(r.text, r.cursor);
      return;
    }

    // Backspace / Delete — Ink maps \x7f (the actual Backspace key on most
    // terminals) to key.delete, and \x08 (Ctrl+H) to key.backspace.
    // Treat both as "delete character before cursor".
    if (key.backspace || key.delete) {
      if (cur > 0) apply(inp.slice(0, cur - 1) + inp.slice(cur), cur - 1);
      return;
    }

    // Ctrl+D — forward-delete (delete character at cursor)
    if (key.ctrl && char === 'd') {
      if (cur < inp.length) apply(inp.slice(0, cur) + inp.slice(cur + 1), cur);
      return;
    }

    // Printable characters — insert at cursor position
    if (char && !key.ctrl && !key.meta) {
      apply(inp.slice(0, cur) + char + inp.slice(cur), cur + char.length);
    }
  });

  const contextFile = showMeta ? detectContextFile(cwd) : null;

  // Build the entire input line as a single string with ANSI styling.
  // Using multiple <Text> sibling nodes causes each to be measured and wrapped
  // independently by Ink's layout engine (squashTextNodes only merges children
  // of the same node). A single <Text> node is squashed into one text block,
  // so Ink wraps it correctly as a continuous stream.
  // The frame color is the at-a-glance state: grey while a turn runs, purple
  // inside a skill, accent otherwise.
  const paint = busy
    ? chalk.gray
    : activeSkill
      ? chalk.hex('#6C63FF')
      : chalk.hex(ACCENT);

  const beforeCursor = input.slice(0, cursor);
  const cursorChar = input[cursor] ?? ' ';
  const afterCursor = input.slice(cursor + 1);
  // busy mode never shows an inverted cursor block — there's nothing to edit,
  // and an inverted character on frozen text reads as "still interactive"
  // when it isn't. Inverting a '\n' would swallow the line break, so the
  // cursor on a line end is drawn as an inverted space before the break.
  const styledMiddle = busy
    ? cursorChar
    : cursorChar === '\n'
      ? chalk.inverse(' ') + '\n'
      : chalk.inverse(cursorChar);
  const allLines = (beforeCursor + styledMiddle + afterCursor).split('\n');

  // Only a window of lines is drawn (≈30% of the terminal); the rules say how
  // many are hidden above and below, so a long paste can't push the prompt
  // off screen.
  const cursorLine = cursorLineIndex(input, cursor);
  const { start, end } = visibleWindow(allLines.length, cursorLine, maxInputRows(rows));
  const hiddenAbove = start;
  const hiddenBelow = allLines.length - end;
  const renderedInput = allLines
    .slice(start, end)
    .map((line) => (busy ? chalk.gray(line) : line))
    .join('\n');

  const topLabel = [activeSkill ?? null, hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : null]
    .filter(Boolean)
    .join(' · ');
  const topRule = paint(buildRule(columns, topLabel || undefined));
  const bottomRule = paint(buildRule(columns, hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : undefined));

  return (
    <Box flexDirection="column">
      {showMeta && (model || contextFile) && (
        <Box marginBottom={0}>
          <Text dimColor>
            {'  '}
            {[
              model,
              contextFile ? `In ${contextFile}` : null,
            ].filter(Boolean).join('  ·  ')}
          </Text>
        </Box>
      )}
      {exitHint && (
        <Text color="yellow">{'(Press Ctrl+C again within 2s to exit)'}</Text>
      )}
      <Text>{topRule}</Text>
      <Box paddingX={1}>
        <Text>{renderedInput}</Text>
      </Box>
      <Text>{bottomRule}</Text>
      {!busy && (
        <Dropdown
          items={dropdownItems}
          selectedIndex={dropdownIndex}
          visible={dropdownVisible}
        />
      )}
    </Box>
  );
}
