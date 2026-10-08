import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { ACCENT } from '../../utils/constants.js';
import type { DropdownProps } from './types.js';

const MAX_VISIBLE = 8;
const MAX_LABEL_COLUMN = 28;

export function Dropdown({ items, selectedIndex, visible }: DropdownProps): React.ReactElement | null {
  if (!visible || items.length === 0) return null;

  const shown = items.slice(0, MAX_VISIBLE);
  const overflow = items.length - MAX_VISIBLE;
  // Descriptions line up in one column so a list of commands scans like a table.
  const labelColumn = Math.min(MAX_LABEL_COLUMN, Math.max(...shown.map((item) => stringWidth(item.label))));

  return (
    <Box flexDirection="column" marginLeft={1}>
      {shown.map((item, i) => {
        const isSelected = i === selectedIndex;
        // Distinct color per kind so slash commands / skills / file paths
        // read as different categories at a glance, not one undifferentiated list.
        const labelColor = item.kind === 'skill' ? 'white' : item.kind === 'file' ? 'green' : ACCENT;
        const pad = ' '.repeat(Math.max(0, labelColumn - stringWidth(item.label)));

        return (
          <Box key={item.value}>
            <Text color={ACCENT}>{isSelected ? '❯ ' : '  '}</Text>
            <Text color={labelColor} bold={isSelected} dimColor={!isSelected}>
              {item.label + pad}
            </Text>
            {item.desc ? <Text dimColor>{'  ' + item.desc}</Text> : null}
          </Box>
        );
      })}
      {overflow > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>…{overflow} more</Text>
        </Box>
      )}
    </Box>
  );
}
