import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ACCENT } from '../../utils/constants.js';
import type { ListPickerProps } from './types.js';
import type { SelectorItem } from '../../utils/select.js';

export function ListPicker({ title, items, currentValue, onSubmit }: ListPickerProps): React.ReactElement {
  const initialIndex = Math.max(0, items.findIndex(i => i.value === currentValue));
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  // Only confirm-style pickers (edit/command approval) have a plain "yes"/"no"
  // value — surface the shortcut hint only there, not on model/session/skill lists.
  const hasYesNoShortcut = items.some(i => i.value === 'yes') && items.some(i => i.value === 'no');

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex(i => Math.min(items.length - 1, i + 1));
    } else if (key.return) {
      onSubmit(items[selectedIndex]?.value ?? null);
    } else if (key.escape || (key.ctrl && _input === 'c')) {
      onSubmit(null);
    } else if (_input === 'y' || _input === 'Y') {
      // Quick-answer for confirm dialogs (edit/command approval): jump
      // straight to "yes" without navigating. Only fires when a plain "yes"
      // item exists — deliberately excludes "yes_all_session", which is a
      // bigger commitment than a single keystroke should grant. Harmless
      // no-op for other pickers (model/session/skill lists) since their
      // values are never literally "yes".
      const yesItem = items.find(i => i.value === 'yes');
      if (yesItem) onSubmit(yesItem.value);
    } else if (_input === 'n' || _input === 'N') {
      const noItem = items.find(i => i.value === 'no');
      if (noItem) onSubmit(noItem.value);
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
        {hasYesNoShortcut && <Text dimColor>{'  (y/n)'}</Text>}
      </Box>
      {items.map((item: SelectorItem, i: number) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={ACCENT}>{isSelected ? '❯ ' : '  '}</Text>
            <Text
              color={item.kind === 'skill' ? 'white' : ACCENT}
              bold={isSelected}
              dimColor={!isSelected}
            >
              {item.label}
            </Text>
            {item.desc ? (
              <Text dimColor>{'  ' + item.desc}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
