import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { mountApp } from '../../src/cli/ink/App.js';
import { write, appendLiveText, commitLiveText, setLiveTool, hasSink } from '../../src/cli/ink/output-channel.js';

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
});
