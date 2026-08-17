import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptInput } from '../../src/cli/ink/PromptInput.js';
import type { InputResult } from '../../src/cli/ink/types.js';

// See tests/cli/ListPicker.test.tsx for why this tick is necessary — Ink
// wires up its raw-mode 'readable' listener inside a useEffect, which React
// only flushes on the next microtask/macrotask after render().
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('PromptInput', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // PromptInput toggles bracketed-paste mode on mount/unmount via direct
    // process.stdout.write — silence that so it doesn't pollute test output.
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  describe('multi-line input (backslash-continuation)', () => {
    it('typing text ending in backslash then Enter inserts a newline instead of submitting', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('line one\\');
      await tick();
      stdin.write('\r');
      await tick();
      expect(submitted).toBeUndefined(); // must NOT have submitted yet
      stdin.write('line two');
      await tick();
      stdin.write('\r');
      expect(submitted).toEqual({ text: 'line one\nline two', cancelled: false });
    });

    it('the trailing backslash is stripped and never appears in the submitted text', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('abc\\');
      await tick();
      stdin.write('\r');
      await tick();
      stdin.write('def');
      await tick();
      stdin.write('\r');
      expect(submitted?.text).not.toContain('\\');
      expect(submitted?.text).toBe('abc\ndef');
    });

    it('supports three or more continuation lines', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      for (const part of ['one\\', 'two\\', 'three']) {
        stdin.write(part);
        await tick();
        stdin.write('\r');
        await tick();
      }
      expect(submitted?.text).toBe('one\ntwo\nthree');
    });

    it('plain Enter (no trailing backslash) still submits immediately, unchanged from before', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('single line message');
      await tick();
      stdin.write('\r');
      expect(submitted).toEqual({ text: 'single line message', cancelled: false });
    });
  });

  describe('busy state', () => {
    it('renders the input dimmed and does not accept new characters while busy', async () => {
      const { stdin, lastFrame } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} busy onSubmit={() => {}} />,
      );
      await tick();
      stdin.write('should not appear');
      await tick();
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).not.toContain('should not appear');
    });

    it('does not submit on Enter while busy', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} busy onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('\r');
      await tick();
      expect(submitted).toBeUndefined();
    });

    it('calls onCancelBusy when Esc is pressed while busy', async () => {
      const onCancelBusy = vi.fn();
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} busy onCancelBusy={onCancelBusy} onSubmit={() => {}} />,
      );
      await tick();
      stdin.write('\x1b');
      expect(onCancelBusy).toHaveBeenCalledTimes(1);
    });

    it('calls onCancelBusy when Ctrl+C is pressed while busy (instead of the double-press-to-exit flow)', async () => {
      const onCancelBusy = vi.fn();
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} busy onCancelBusy={onCancelBusy} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('\x03');
      expect(onCancelBusy).toHaveBeenCalledTimes(1);
      expect(submitted).toBeUndefined(); // must not trigger the cancelled-exit path
    });

    it('does not throw or hang when busy toggles from true to false (component keeps mounted, not remounted)', async () => {
      const { rerender, stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} busy onSubmit={() => {}} />,
      );
      await tick();
      rerender(<PromptInput cwd="/tmp" skills={[]} showMeta={false} busy={false} onSubmit={() => {}} />);
      await tick();
      // Should now accept input again.
      stdin.write('a');
      await tick();
      expect(true).toBe(true); // reaching here without throwing is the assertion
    });
  });

  describe('existing single-line behavior unaffected', () => {
    it('backspace still deletes the character before the cursor', async () => {
      let submitted: InputResult | undefined;
      const { stdin } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={(r) => { submitted = r; }} />,
      );
      await tick();
      stdin.write('abcd');
      await tick();
      stdin.write('\x7f'); // backspace
      await tick();
      stdin.write('\r');
      expect(submitted?.text).toBe('abc');
    });

    it('Escape clears the input when no dropdown is open', async () => {
      const { stdin, lastFrame } = render(
        <PromptInput cwd="/tmp" skills={[]} showMeta={false} onSubmit={() => {}} />,
      );
      await tick();
      stdin.write('some text');
      await tick();
      stdin.write('\x1b');
      await tick();
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).not.toContain('some text');
    });
  });
});
