import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maybeAutoCompact } from '../../src/core/agent/loop.js';
import { ContextManager } from '../../src/core/context/manager.js';
import * as compactModule from '../../src/core/context/compact.js';
import * as storeModule from '../../src/core/memory/store.js';
import type { LLMProvider, StreamChunk } from '../../src/types.js';

function makeProvider(): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text: 'a summary' };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

describe('maybeAutoCompact', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(storeModule, 'saveSessionSummary').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when the context has not flagged needsCompact', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = false;
    const compactSpy = vi.spyOn(compactModule, 'compactMessages');

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', true);

    expect(compactSpy).not.toHaveBeenCalled();
  });

  it('calls compactMessages and clears needsCompact when autoCompactEnabled is true', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = true;
    vi.spyOn(compactModule, 'compactMessages').mockResolvedValue({
      summary: 'summary text',
      beforeTokens: 500,
      afterTokens: 50,
    });
    const compactSpy = vi.spyOn(context, 'compact');

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', true);

    expect(compactModule.compactMessages).toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith('summary text');
    expect(context.needsCompact).toBe(false);
  });

  it('does NOT call compactMessages when autoCompactEnabled is false, and leaves needsCompact set', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = true;
    const compactSpy = vi.spyOn(compactModule, 'compactMessages');

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', false);

    expect(compactSpy).not.toHaveBeenCalled();
    // Left true so the warning repeats every turn until the user runs /compact.
    expect(context.needsCompact).toBe(true);
  });

  it('prints a warning (not a silent no-op) when autoCompactEnabled is false', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = true;

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', false);

    const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
    expect(written).toMatch(/near capacity/i);
  });

  it('clears needsCompact even when compactMessages returns null (nothing to summarize)', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = true;
    vi.spyOn(compactModule, 'compactMessages').mockResolvedValue(null);

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', true);

    expect(context.needsCompact).toBe(false);
  });

  it('clears needsCompact and does not throw when compactMessages rejects', async () => {
    const context = new ContextManager(1000);
    context.needsCompact = true;
    vi.spyOn(compactModule, 'compactMessages').mockRejectedValue(new Error('llm error'));

    await expect(
      maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', true)
    ).resolves.not.toThrow();
    expect(context.needsCompact).toBe(false);
  });

  it('treats autoCompactEnabled as required (caller supplies the resolved default, e.g. config.autoCompact ?? true)', async () => {
    // maybeAutoCompact itself has no implicit default — verifying the boolean
    // is passed straight through with no additional fallback inside the function.
    const context = new ContextManager(1000);
    context.needsCompact = true;
    const compactSpy = vi.spyOn(compactModule, 'compactMessages').mockResolvedValue({
      summary: 's', beforeTokens: 10, afterTokens: 5,
    });

    await maybeAutoCompact(context, makeProvider(), 'deepseek-v4-pro', 'en', '/repo', true);
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });
});
