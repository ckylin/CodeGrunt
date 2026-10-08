import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runWorker } from '../../src/core/agent/worker.js';
import { clearSubagentCache } from '../../src/core/agent/subagent-cache.js';
import type { LLMProvider, StreamChunk } from '../../src/types.js';

function makeTextProvider(text: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

/** Calls the given tool once, then returns a final text answer referencing the result. */
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

function makeInfiniteToolCallProvider(toolName: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'tool_call_delta', index: 0, id: 'call_x', name: toolName, arguments_delta: '{}' };
      yield { type: 'finish', finish_reason: 'tool_calls' };
    },
  };
}

describe('runWorker', () => {
  let dir: string;

  beforeEach(() => {
    clearSubagentCache();
  });

  it('behaves like a read-only sub-agent by default (allowWrite not set)', async () => {
    const provider = makeInfiniteToolCallProvider('write_file');
    const result = await runWorker({ task: 'try to write a file', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/max iterations/i);
  });

  it('grants write_file access when allowWrite is true', async () => {
    dir = join(tmpdir(), `codegrunt-worker-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'out.txt');

    const provider = makeToolCallThenAnswerProvider(
      'write_file',
      { path: filePath, content: 'hello from worker' },
      'File written successfully.',
    );
    const result = await runWorker({
      task: 'write a file', cwd: dir, provider, model: 'deepseek-v4-pro', allowWrite: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('File written successfully.');
    expect(result.toolCallCount).toBe(1);

    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('still executes read-only tools when allowWrite is true', async () => {
    dir = join(tmpdir(), `codegrunt-worker-read-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'hello.txt');
    await writeFile(filePath, 'hello world');

    const provider = makeToolCallThenAnswerProvider('read_file', { path: filePath }, 'The file says hello world.');
    const result = await runWorker({
      task: 'read hello.txt', cwd: dir, provider, model: 'deepseek-v4-pro', allowWrite: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('The file says hello world.');

    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('still rejects execute_shell even when allowWrite is true', async () => {
    const provider = makeInfiniteToolCallProvider('execute_shell');
    const result = await runWorker({
      task: 'try to run a shell command', cwd: process.cwd(), provider, model: 'deepseek-v4-pro', allowWrite: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/max iterations/i);
  });

  it('returns a plain text answer with no tool calls, same as runSubagent', async () => {
    const provider = makeTextProvider('42');
    const result = await runWorker({ task: 'what is the answer?', cwd: process.cwd(), provider, model: 'deepseek-v4-pro' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('42');
  });
});
