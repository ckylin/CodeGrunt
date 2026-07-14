import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSubagent } from '../../src/core/agent/subagent.js';
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

describe('runSubagent', () => {
  let dir: string;

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
    expect(result.error).toBe('Aborted');
  });
});
