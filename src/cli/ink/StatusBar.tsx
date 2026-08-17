import React from 'react';
import { Box, Text } from 'ink';
import { ACCENT } from '../../utils/constants.js';

export interface StatusBarProps {
  model: string;
  /** Cached once at REPL startup — a per-render `git` subprocess call would
   *  be wasteful for something that changes maybe once per session. */
  gitBranch: string | null;
  /** Session-cumulative token count, not per-turn — matches what /cost
   *  already reports, so the status bar and /cost never disagree. */
  totalTokens: number;
  /** Set only while a turn is actively running; null the rest of the time. */
  busySince: number | null;
  /** Live elapsed seconds while busy — passed in rather than computed here
   *  so the parent's own ticking interval is the single source of truth
   *  and this component stays a pure render of props. */
  elapsedSeconds: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function StatusBar({ model, gitBranch, totalTokens, busySince, elapsedSeconds }: StatusBarProps): React.ReactElement {
  const segments = [
    model,
    gitBranch ? `⎇ ${gitBranch}` : null,
    totalTokens > 0 ? `${formatTokens(totalTokens)} tokens` : null,
  ].filter(Boolean);

  return (
    <Box justifyContent="space-between">
      <Text dimColor>{segments.join('  ·  ')}</Text>
      {busySince !== null && (
        <Text color={ACCENT}>{`${elapsedSeconds}s · Esc to cancel`}</Text>
      )}
    </Box>
  );
}
