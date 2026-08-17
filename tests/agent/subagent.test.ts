import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSubagent, runSubagentsConcurrent, type SubagentRunOptions } from '../../src/core/agent/subagent.js';
import { clearSubagentCache } from '../../src/core/agent/subagent-cache.js';
import type { LLMProvider, StreamChunk } from '../../src/types.js';

// ── Stub provider builders ──────────────────────────────────────────────────

/** A provider that immediately returns a fixed text answer with no tool calls. */
function makeTextProvider(text: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

/**
 * A provider that calls `read_file` once on the first turn, then returns
 * a final text answer referencing the tool result on the second turn.
 */
function makeToolCallThenAnswerProvider(toolName: string, toolArgs: Record<string, unknown>, finalAnswer: string): LLMProvider {
  let call = 0;
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      call++;
      if (call === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'call_1', name: toolName, arguments_delta: JSON.stringify(toolArgs) };
        yield { type: 'finish', finish_reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: finalAnswer };
        yield { type: 'finish', finish_reason: 'stop' };
      }
    },
  };
}

/** A provider that always requests the same disallowed tool, forever (to test max-iteration exhaustion). */
function makeInfiniteToolCallProvider(toolName: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'tool_call_delta', index: 0, id: 'call_x', name: toolName, arguments_delta: '{}' };
      yield { type: 'finish', finish_reason: 'tool_calls' };
    },
  };
}

function makeErrorProvider(): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      throw new Error('network blew up');
    },
  };
}

/** A provider whose stream never yields and only rejects once its abort signal fires — mirrors a real provider using `fetch(..., { signal })`. */
function makeSlowProvider(): LLMProvider {
  return {
    id: 'stub',
    async *stream(_messages, options): AsyncIterable<StreamChunk> {
      const signal = options.signal;
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(new Error('Sub-agent stream aborted'));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      // Unreachable in practice — the await above only settles via rejection.
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

/** Tracks how many concurrent `stream()` calls are in flight at once (peak.max). */
function makeConcurrencyTrackingProvider(peak: { current: number; max: number }, delayMs = 20): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      peak.current++;
      peak.max = Math.max(peak.max, peak.current);
      await new Promise(r => setTimeout(r, delayMs));
      peak.current--;
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

describe('runSubagent', () => {
  let dir: string;

  beforeEach(() => {
    clearSubagentCache();
  });

  it('returns the final text answer for a no-tool-call response', async () => {
    const provider = makeTextProvider('The answer is 42.');
    const result = await runSubagent({ task: 'what is the answer?', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('The answer is 42.');
    expect(result.toolCallCount).toBe(0);
  });

  it('executes an allowed read-only tool call and returns the follow-up answer', async () => {
    dir = join(tmpdir(), `codegrunt-subagent-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'hello.txt');
    await writeFile(filePath, 'hello world');

    const provider = makeToolCallThenAnswerProvider('read_file', { path: filePath }, 'The file contains hello world.');
    const result = await runSubagent({ task: 'read hello.txt', cwd: dir, provider, model: 'deepseek-v4-pro' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('The file contains hello world.');
    expect(result.toolCallCount).toBe(1);

    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('rejects a disallowed destructive tool without executing it', async () => {
    // The sub-agent keeps calling write_file forever since it never gets a
    // successful result — this exercises both the rejection path AND the
    // max-iteration exhaustion path in one assertion.
    const provider = makeInfiniteToolCallProvider('write_file');
    const result = await runSubagent({ task: 'try to write a file', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/max iterations/i);
  });

  it('surfaces provider errors as a failed result rather than throwing', async () => {
    const provider = makeErrorProvider();
    const result = await runSubagent({ task: 'anything', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('network blew up');
  });

  it('respects an already-aborted signal', async () => {
    const provider = makeTextProvider('should not see this');
    const controller = new AbortController();
    controller.abort();
    const result = await runSubagent({ task: 'anything', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', signal: controller.signal });
    expect(result.success).toBe(false);
    // v0.7: timeout wrapper produces "cancelled" instead of bare "Aborted"
    expect(result.error).toContain('cancelled');
  });

  it('times out a slow sub-agent and reports the elapsed time', async () => {
    const provider = makeSlowProvider();
    const result = await runSubagent({
      task: 'take forever', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', timeoutMs: 30,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout|timed out|aborted/i);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('caches a successful result and returns it on a second call without re-invoking the provider', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      id: 'stub',
      async *stream(): AsyncIterable<StreamChunk> {
        callCount++;
        yield { type: 'text_delta', text: 'cached answer' };
        yield { type: 'finish', finish_reason: 'stop' };
      },
    };
    const opts: SubagentRunOptions = { task: 'same question', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', useCache: true };

    const first = await runSubagent(opts);
    const second = await runSubagent(opts);

    expect(first.output).toBe('cached answer');
    expect(second.output).toBe('cached answer');
    expect(callCount).toBe(1); // second call served entirely from cache
    expect(second.durationMs).toBe(0); // cache hits report zero elapsed time
  });

  it('does not share cached results across different tasks', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      id: 'stub',
      async *stream(): AsyncIterable<StreamChunk> {
        callCount++;
        yield { type: 'text_delta', text: `answer ${callCount}` };
        yield { type: 'finish', finish_reason: 'stop' };
      },
    };
    await runSubagent({ task: 'question A', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', useCache: true });
    await runSubagent({ task: 'question B', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', useCache: true });
    expect(callCount).toBe(2);
  });
});

describe('runSubagentsConcurrent', () => {
  beforeEach(() => {
    clearSubagentCache();
  });

  it('runs multiple tasks and aggregates their results in order', async () => {
    const providerA = makeTextProvider('answer A');
    const providerB = makeTextProvider('answer B');
    const result = await runSubagentsConcurrent({
      tasks: [
        { task: 'q A', cwd: process.cwd(), provider: providerA, model: 'deepseek-v4-pro' },
        { task: 'q B', cwd: process.cwd(), provider: providerB, model: 'deepseek-v4-pro' },
      ],
    });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.map(r => r.output)).toEqual(['answer A', 'answer B']);
  });

  it('never runs more sub-agents in parallel than the configured concurrency limit', async () => {
    const peak = { current: 0, max: 0 };
    const provider = makeConcurrencyTrackingProvider(peak, 20);
    const tasks: SubagentRunOptions[] = Array.from({ length: 6 }, (_, i) => ({
      task: `task ${i}`, cwd: process.cwd(), provider, model: 'deepseek-v4-pro',
    }));

    await runSubagentsConcurrent({ tasks, concurrency: 2 });
    expect(peak.max).toBeLessThanOrEqual(2);
  });

  it('caps concurrency at MAX_CONCURRENT_SUBAGENTS (10) even if a higher value is requested', async () => {
    const peak = { current: 0, max: 0 };
    const provider = makeConcurrencyTrackingProvider(peak, 5);
    const tasks: SubagentRunOptions[] = Array.from({ length: 12 }, (_, i) => ({
      task: `task ${i}`, cwd: process.cwd(), provider, model: 'deepseek-v4-pro',
    }));

    await runSubagentsConcurrent({ tasks, concurrency: 50 });
    expect(peak.max).toBeLessThanOrEqual(10);
  });

  it('throws with an aggregated error message when a task fails and partial failure is not allowed', async () => {
    const okProvider = makeTextProvider('fine');
    const failProvider = makeErrorProvider();
    await expect(
      runSubagentsConcurrent({
        tasks: [
          { task: 'ok', cwd: process.cwd(), provider: okProvider, model: 'deepseek-v4-pro' },
          { task: 'fails', cwd: process.cwd(), provider: failProvider, model: 'deepseek-v4-pro' },
        ],
      }),
    ).rejects.toThrow(/1\/2 failed/);
  });

  it('returns a mixed success/failure result set when allowPartialFailure is true', async () => {
    const okProvider = makeTextProvider('fine');
    const failProvider = makeErrorProvider();
    const result = await runSubagentsConcurrent({
      tasks: [
        { task: 'ok', cwd: process.cwd(), provider: okProvider, model: 'deepseek-v4-pro' },
        { task: 'fails', cwd: process.cwd(), provider: failProvider, model: 'deepseek-v4-pro' },
      ],
      allowPartialFailure: true,
    });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.some(r => r.success && r.output === 'fine')).toBe(true);
    expect(result.results.some(r => !r.success && r.error?.includes('network blew up'))).toBe(true);
  });

  it('propagates a shared abort signal to all sub-agents', async () => {
    const provider = makeSlowProvider();
    const controller = new AbortController();
    controller.abort();
    const result = await runSubagentsConcurrent({
      tasks: [{ task: 'anything', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' }],
      signal: controller.signal,
      allowPartialFailure: true,
    });
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
  });
});
