import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptInput } from '../../src/cli/ink/PromptInput.js';
import { Dropdown } from '../../src/cli/ink/Dropdown.js';
import { getAutocompleteItems } from '../../src/cli/ink/useAutocomplete.js';
import type { InputResult } from '../../src/cli/ink/types.js';

// Submitting would append to the real ~/.codegrunt/history; keep tests off it.
vi.mock('../../src/cli/ink/useHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/ink/useHistory.js')>();
  return { ...actual, saveHistoryEntry: vi.fn() };
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const isRule = (line: string): boolean => /^─+/.test(line) && /─$/.test(line);

describe('PromptInput frame and editing keys', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  async function setup(extra: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
    let submitted: InputResult | undefined;
    const r = render(
      <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(res) => { submitted = res; }} {...extra} />,
    );
    await tick();
    return { ...r, submitted: () => submitted };
  }

  it('frames the input between two horizontal rules, with no "> " glyph', async () => {
    const { stdin, lastFrame } = await setup();
    stdin.write('hello');
    await tick();
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const rules = lines.filter(isRule);
    expect(rules).toHaveLength(2);
    expect(lines.indexOf(rules[0])).toBeLessThan(lines.findIndex((l) => l.includes('hello')));
    expect(lines.findIndex((l) => l.includes('hello'))).toBeLessThan(lines.lastIndexOf(rules[1]));
    expect(lines.some((l) => l.trimStart().startsWith('>'))).toBe(false);
  });

  it('shows the active skill name inside the top rule', async () => {
    const { lastFrame } = await setup({ activeSkill: 'review' });
    const top = stripAnsi(lastFrame() ?? '').split('\n').find((l) => l.includes('review')) ?? '';
    expect(top).toMatch(/^──\s+review\s+─+$/);
  });

  it('Ctrl+J inserts a newline instead of submitting', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('one');
    await tick();
    stdin.write('\n');
    await tick();
    stdin.write('two');
    await tick();
    expect(submitted()).toBeUndefined();
    stdin.write('\r');
    expect(submitted()?.text).toBe('one\ntwo');
  });

  it('Ctrl+W deletes the previous word', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('keep this word');
    await tick();
    stdin.write('\x17');
    await tick();
    stdin.write('\r');
    expect(submitted()?.text).toBe('keep this');
  });

  it('Ctrl+U deletes to the start of the line and Ctrl+K to the end', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('abcdef');
    await tick();
    stdin.write('\x1b[D\x1b[D'); // cursor between "abcd" and "ef"
    await tick();
    stdin.write('\x0b'); // Ctrl+K
    await tick();
    stdin.write('\x15'); // Ctrl+U
    await tick();
    stdin.write('Z');
    await tick();
    stdin.write('\r');
    expect(submitted()?.text).toBe('Z');
  });

  it('Alt+Left jumps back a word', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('foo bar');
    await tick();
    stdin.write('\x1b[1;3D'); // Alt+Left
    await tick();
    stdin.write('X');
    await tick();
    stdin.write('\r');
    expect(submitted()?.text).toBe('foo Xbar');
  });

  it('Up/Down move between lines of a multi-line entry before touching history', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('aaa');
    await tick();
    stdin.write('\n');
    await tick();
    stdin.write('bbb');
    await tick();
    stdin.write('\x1b[A'); // Up: onto line one, not history
    await tick();
    stdin.write('X');
    await tick();
    stdin.write('\r');
    expect(submitted()?.text).toBe('aaaX\nbbb');
  });

  it('scrolls a tall input and reports hidden lines in the rules', async () => {
    const { stdin, lastFrame } = await setup();
    const tall = Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join('\n');
    stdin.write(tall);
    await tick();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/↑ \d+ more/);
    expect(frame).toContain('row30');
    expect(frame).not.toContain('row1\n');
    expect(frame.split('\n').length).toBeLessThan(15);
  });

  it('wraps the dropdown selection from the first item to the last with Up', async () => {
    const { stdin, submitted } = await setup();
    stdin.write('/');
    await tick();
    const items = getAutocompleteItems('/', 1, '/tmp', []);
    expect(items.length).toBeGreaterThan(1);
    stdin.write('\x1b[A');
    await tick();
    stdin.write('\r');
    expect(submitted()?.text).toBe(items[items.length - 1].value.trim());
  });
});

describe('Dropdown', () => {
  it('aligns descriptions in one column and marks the selected row', () => {
    const items = [
      { value: '/a', label: '/a', desc: 'first', kind: 'builtin' as const },
      { value: '/longer', label: '/longer', desc: 'second', kind: 'builtin' as const },
    ];
    const { lastFrame } = render(<Dropdown items={items} selectedIndex={1} visible />);
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    expect(lines[0].indexOf('first')).toBe(lines[1].indexOf('second'));
    expect(lines[1]).toContain('❯');
    expect(lines[0]).not.toContain('❯');
  });

  it('renders nothing when not visible', () => {
    const { lastFrame } = render(<Dropdown items={[]} selectedIndex={0} visible={false} />);
    expect(lastFrame()).toBe('');
  });
});
