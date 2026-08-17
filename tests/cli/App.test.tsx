import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { mountApp } from '../../src/cli/ink/App.js';
import {
  write, appendLiveText, commitLiveText, setLiveTool, hasSink, getPickerHandler,
} from '../../src/cli/ink/output-channel.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// See tests/cli/ListPicker.test.tsx for why this tick is necessary.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('mountApp', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('registers an output-channel sink on mount', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    expect(hasSink()).toBe(true);
    app.unmount();
  });

  it('unregisters the sink on unmount, falling back to stdout again', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    app.unmount();
    expect(hasSink()).toBe(false);
  });

  it('write() calls routed through output-channel appear in the rendered frame as history', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    write('a completed history line');
    await tick();
    app.unmount();
  });

  it('appendLiveText/commitLiveText do not throw once routed through a mounted App', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    appendLiveText('streaming...');
    await tick();
    commitLiveText();
    await tick();
    app.unmount();
  });

  it('setLiveTool via output-channel does not throw once routed through a mounted App', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    setLiveTool({ name: 'read_file', argPreview: 'x.ts', frame: '⠋', elapsedMs: 0 });
    await tick();
    setLiveTool(null);
    app.unmount();
  });

  it('promptForInput() resolves with the submitted text when the user types and presses Enter', async () => {
    // Capture the ink-testing-library instance mountApp creates internally
    // so this test can drive its stdin directly, rather than mountApp's own
    // (real process.stdin) render — renderFn is exactly the seam that makes
    // this possible.
    let captured: ReturnType<typeof render> | null = null;
    const capturingRenderFn = ((node: any, opts: any) => {
      captured = render(node, opts);
      return captured;
    }) as typeof render;

    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: capturingRenderFn,
    });
    await tick();

    const promise = app.promptForInput();
    let resolved: { text: string; cancelled: boolean } | undefined;
    promise.then((r) => { resolved = r; });

    await tick();
    expect(resolved).toBeUndefined(); // must not resolve before the user types anything

    captured!.stdin.write('hello from the test');
    await tick();
    captured!.stdin.write('\r');
    await tick();

    expect(resolved).toEqual({ text: 'hello from the test', cancelled: false });
    app.unmount();
  });

  it('setBusy(true) then setBusy(false) does not throw across a full busy cycle', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    app.setBusy(true);
    await tick();
    app.setBusy(false);
    await tick();
    app.unmount();
  });

  it('setTotalTokens() does not throw', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    app.setTotalTokens(1234);
    await tick();
    app.unmount();
  });

  it('onCancelBusy() registers a handler without throwing', async () => {
    const app = mountApp({
      cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
      renderFn: render as any,
    });
    await tick();
    const handler = vi.fn();
    app.onCancelBusy(handler);
    await tick();
    app.unmount();
  });

  describe('picker delegation (real bug regression coverage)', () => {
    // Ink keys its render() instances by the stdout stream — a second
    // independent render() call while this App is mounted would silently
    // REPLACE this App's tree rather than coexist with it. App.tsx registers
    // a picker handler on mount specifically so select.ts routes through
    // THIS tree instead of calling render() itself. These tests drive that
    // path end to end: register → open picker → select → resolve → prompt
    // returns.

    it('registers a picker handler on mount', async () => {
      const app = mountApp({
        cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
        renderFn: render as any,
      });
      await tick();
      expect(getPickerHandler()).not.toBeNull();
      app.unmount();
    });

    it('unregisters the picker handler on unmount', async () => {
      const app = mountApp({
        cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
        renderFn: render as any,
      });
      await tick();
      app.unmount();
      expect(getPickerHandler()).toBeNull();
    });

    it('renders the picker inside the SAME tree, replacing PromptInput, and resolves via a real keypress', async () => {
      let captured: ReturnType<typeof render> | null = null;
      const capturingRenderFn = ((node: any, opts: any) => {
        captured = render(node, opts);
        return captured;
      }) as typeof render;

      const app = mountApp({
        cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
        renderFn: capturingRenderFn,
      });
      await tick();

      const handler = getPickerHandler();
      expect(handler).not.toBeNull();

      const items = [{ value: 'opt-a', label: 'Option A' }, { value: 'opt-b', label: 'Option B' }];
      const resultPromise = handler!('Choose one', items);
      await tick();

      const frame = stripAnsi(captured!.lastFrame() ?? '');
      expect(frame).toContain('Choose one');
      expect(frame).toContain('Option A');
      // PromptInput's own prompt glyph must NOT be visible while the picker is up.
      expect(frame).not.toContain('>');

      // Select the second option and confirm via Enter, same as a real user.
      captured!.stdin.write('\x1b[B'); // down arrow
      await tick();
      captured!.stdin.write('\r');
      await tick();

      expect(await resultPromise).toBe('opt-b');
      app.unmount();
    });

    it('the prompt reappears after the picker resolves', async () => {
      let captured: ReturnType<typeof render> | null = null;
      const capturingRenderFn = ((node: any, opts: any) => {
        captured = render(node, opts);
        return captured;
      }) as typeof render;

      const app = mountApp({
        cwd: '/tmp', model: 'm', gitBranch: null, skills: [], showMeta: false,
        renderFn: capturingRenderFn,
      });
      await tick();

      const handler = getPickerHandler()!;
      const resultPromise = handler('Choose one', [{ value: 'a', label: 'A' }]);
      await tick();
      captured!.stdin.write('\r'); // accept the only/highlighted item
      await tick();
      await resultPromise;
      await tick();

      const frame = stripAnsi(captured!.lastFrame() ?? '');
      expect(frame).not.toContain('Choose one');
      app.unmount();
    });
  });
});
