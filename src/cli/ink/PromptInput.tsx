import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { accessSync } from 'fs';
import { join } from 'path';
import { ACCENT } from '../../utils/constants.js';
import { Dropdown } from './Dropdown.js';
import { createHistoryController, saveHistoryEntry } from './useHistory.js';
import { getAutocompleteItems } from './useAutocomplete.js';
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
}: PromptInputProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [exitHint, setExitHint] = useState(false);
  const historyCtrl = useRef(createHistoryController());
  // Refs mirror state so useInput callbacks always read the latest values.
  // Updated synchronously in the handler (not via useEffect) so rapid keypresses
  // never see stale values between React renders.
  const inputRef = useRef('');
  const cursorRef = useRef(0);
  const lastCtrlCRef = useRef(0);

  const apply = (nextInput: string, nextCursor: number) => {
    inputRef.current = nextInput;
    cursorRef.current = nextCursor;
    setInput(nextInput);
    setCursor(nextCursor);
  };

  const dropdownItems = getAutocompleteItems(input, cwd, skills);
  const dropdownVisible = dropdownItems.length > 0;

  // Reset dropdown selection when items change
  useEffect(() => {
    setDropdownIndex(0);
  }, [input]);

  useInput((char, key) => {
    const cur = cursorRef.current;
    const inp = inputRef.current;

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

    // Left arrow — move cursor left
    if (key.leftArrow) {
      cursorRef.current = Math.max(0, cur - 1);
      setCursor(cursorRef.current);
      return;
    }

    // Right arrow — move cursor right
    if (key.rightArrow) {
      cursorRef.current = Math.min(inp.length, cur + 1);
      setCursor(cursorRef.current);
      return;
    }

    // Arrow up
    if (key.upArrow) {
      if (dropdownVisible) {
        setDropdownIndex(i => Math.max(0, i - 1));
      } else {
        const prev = historyCtrl.current.navigateUp(inp);
        apply(prev, prev.length);
      }
      return;
    }

    // Arrow down
    if (key.downArrow) {
      if (dropdownVisible) {
        setDropdownIndex(i => Math.min(dropdownItems.length - 1, i + 1));
      } else {
        const next = historyCtrl.current.navigateDown();
        apply(next, next.length);
      }
      return;
    }

    // Tab — accept dropdown selection if open
    if (key.tab) {
      if (dropdownVisible) {
        const selected = dropdownItems[dropdownIndex];
        if (selected) apply(selected.value, selected.value.length);
      }
      return;
    }

    // Escape — close dropdown or clear input
    if (key.escape) {
      apply('', 0);
      return;
    }

    // Enter — accept dropdown or submit
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
            apply(selected.value, selected.value.length);
          }
        }
        return;
      }

      const trimmed = inp.trim();
      if (!trimmed) return;
      historyCtrl.current.addEntry(trimmed);
      saveHistoryEntry(trimmed);
      onSubmit({ text: trimmed, cancelled: false });
      return;
    }

    // Home — move cursor to start
    if (char === '\x1b[H' || (key.ctrl && char === 'a')) {
      cursorRef.current = 0;
      setCursor(0);
      return;
    }

    // End — move cursor to end
    if (char === '\x1b[F' || (key.ctrl && char === 'e')) {
      cursorRef.current = inp.length;
      setCursor(inp.length);
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

  const promptStr = activeSkill
    ? `[${activeSkill}] > `
    : '> ';

  const contextFile = showMeta ? detectContextFile(cwd) : null;

  // Build the entire input line as a single string with ANSI styling.
  // Using multiple <Text> sibling nodes causes each to be measured and wrapped
  // independently by Ink's layout engine (squashTextNodes only merges children
  // of the same node). A single <Text> node is squashed into one text block,
  // so Ink wraps it correctly as a continuous stream.
  const promptStyled = activeSkill
    ? chalk.hex('#6C63FF').bold(promptStr)
    : chalk.hex(ACCENT)(promptStr);

  const beforeCursor = input.slice(0, cursor);
  const cursorChar = input[cursor] ?? ' ';
  const afterCursor = input.slice(cursor + 1);
  const inputLine = beforeCursor + chalk.inverse(cursorChar) + afterCursor;

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
      <Text>{promptStyled + inputLine}</Text>
      <Dropdown
        items={dropdownItems}
        selectedIndex={dropdownIndex}
        visible={dropdownVisible}
      />
    </Box>
  );
}
