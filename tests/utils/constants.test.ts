import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme, muted } from '../../src/utils/constants.js';
import * as constants from '../../src/utils/constants.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('applyTheme / ACCENT / muted', () => {
  afterEach(() => {
    // Reset to default so other test files aren't affected by theme state
    // leaking across the shared module instance.
    applyTheme('dark');
  });

  it('defaults ACCENT to the dark-theme blue', () => {
    applyTheme('dark');
    expect(constants.ACCENT).toBe('#4A90D9');
  });

  it('switches ACCENT to a darker blue for the light theme', () => {
    applyTheme('light');
    expect(constants.ACCENT).toBe('#1D5D96');
    expect(constants.ACCENT).not.toBe('#4A90D9');
  });

  it('switching back to dark restores the original ACCENT', () => {
    applyTheme('light');
    applyTheme('dark');
    expect(constants.ACCENT).toBe('#4A90D9');
  });

  it('muted() preserves the wrapped text content regardless of theme', () => {
    applyTheme('dark');
    expect(stripAnsi(muted('some text'))).toBe('some text');
    applyTheme('light');
    expect(stripAnsi(muted('some text'))).toBe('some text');
  });
});
