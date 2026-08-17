import React from 'react';
import { Box, Text } from 'ink';
import { ACCENT } from '../../utils/constants.js';
import type { DropdownProps } from './types.js';

const MAX_VISIBLE = 8;

export function Dropdown({ items, selectedIndex, visible }: DropdownProps): React.ReactElement | null {
  if (!visible || items.length === 0) return null;

  const visible_items = items.slice(0, MAX_VISIBLE);
  const overflow = items.length - MAX_VISIBLE;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {visible_items.map((item, i) => {
        const isSelected = i === selectedIndex;
        const indicator = isSelected ? '❯ ' : '  ';
        // Distinct color per kind so slash commands / skills / file paths
        // read as different categories at a glance, not one undifferentiated list.
        const labelColor = item.kind === 'skill' ? 'white' : item.kind === 'file' ? 'green' : ACCENT;

        return (
          <Box key={item.value}>
            <Text color={ACCENT}>{indicator}</Text>
            <Text color={labelColor} bold={isSelected} dimColor={!isSelected}>
              {item.label}
            </Text>
            {item.desc ? (
              <Text dimColor>{'  ' + item.desc}</Text>
            ) : null}
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
