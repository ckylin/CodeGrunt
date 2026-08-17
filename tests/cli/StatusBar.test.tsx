import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../src/cli/ink/StatusBar.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('StatusBar', () => {
  it('shows the model name', () => {
    const { lastFrame } = render(
      <StatusBar model="deepseek-v4-pro" gitBranch={null} totalTokens={0} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('deepseek-v4-pro');
  });

  it('shows the git branch when provided', () => {
    const { lastFrame } = render(
      <StatusBar model="m" gitBranch="develop" totalTokens={0} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('develop');
  });

  it('omits the git branch segment when null (non-git directory)', () => {
    const { lastFrame } = render(
      <StatusBar model="m" gitBranch={null} totalTokens={0} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('⎇');
  });

  it('formats token counts under 1000 as a plain number', () => {
    const { lastFrame } = render(
      <StatusBar model="m" gitBranch={null} totalTokens={523} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('523 tokens');
  });

  it('formats token counts >= 1000 with a "k" suffix', () => {
    const { lastFrame } = render(
      <StatusBar model="m" gitBranch={null} totalTokens={12500} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('12.5k tokens');
  });

  it('omits the token segment entirely when totalTokens is 0 (no session usage yet)', () => {
    const { lastFrame } = render(
      <StatusBar model="m" gitBranch={null} totalTokens={0} busySince={null} elapsedSeconds={0} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('tokens');
  });

  it('shows elapsed time and the Esc-to-cancel hint only while busy', () => {
    const idle = render(
      <StatusBar model="m" gitBranch={null} totalTokens={0} busySince={null} elapsedSeconds={5} />,
    );
    expect(stripAnsi(idle.lastFrame() ?? '')).not.toContain('Esc to cancel');

    const busy = render(
      <StatusBar model="m" gitBranch={null} totalTokens={0} busySince={Date.now()} elapsedSeconds={5} />,
    );
    const frame = stripAnsi(busy.lastFrame() ?? '');
    expect(frame).toContain('5s');
    expect(frame).toContain('Esc to cancel');
  });
});
