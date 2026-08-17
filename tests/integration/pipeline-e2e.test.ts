// ── Full-Chain Pipeline Integration Test ─────────────────────────────────────
// Wires the REAL 4 pipeline stages (PrepareContext → StreamResponse →
// ProcessToolCalls → PostProcess) together against a scripted mock provider
// and REAL tool execution in a tmp directory. This is the gap CLAUDE.md's
// "Known Issues" section calls out: existing pipeline tests only exercise
// stub stages (tests/pipeline/engine.test.ts), not the actual production
// stages wired end to end.
//
// setTrustMode('auto') bypasses the interactive confirm-dialog UI for
// destructive tools (write_file/edit_file/execute_shell) — without it, this
// test would hang waiting for a keypress that never arrives in a CI/test
// environment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineEngine, PipelineBuilder } from '../../src/core/pipeline/engine.js';
import { PrepareContextStage, pushUserMessage } from '../../src/core/pipeline/stages/prepare-context.js';
import { StreamResponseStage } from '../../src/core/pipeline/stages/stream-response.js';
import { ProcessToolCallsStage } from '../../src/core/pipeline/stages/process-tools.js';
import { PostProcessStage } from '../../src/core/pipeline/stages/post-process.js';
import { setTrustMode, resetYesAll } from '../../src/core/pipeline/stages/process-tools-helpers.js';
import { createScriptedProvider } from '../helpers/mock-provider.js';
import type { PipelineContext } from '../../src/core/pipeline/types.js';
import type { CodeGruntConfig } from '../../src/types.js';

function buildPipeline() {
  return new PipelineBuilder()
    .name('e2e-test')
    .addStage(new PrepareContextStage())
    .addStage(new StreamResponseStage())
    .addStage(new ProcessToolCallsStage())
    .addStage(new PostProcessStage())
    .build();
}

function makeConfig(): CodeGruntConfig {
  return { provider: 'mock', model: 'mock-model', maxTokens: 1024, temperature: 0, apiKey: '', baseURL: '' };
}

describe('full-chain pipeline integration (real stages, real tool execution, mock LLM)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-e2e-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    setTrustMode('auto'); // bypass the confirm dialog for this test's write_file call
  });

  afterEach(async () => {
    resetYesAll();
    setTrustMode('code'); // restore default so this doesn't leak into other test files
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('runs a single-turn text-only conversation through all 4 stages', async () => {
    const provider = createScriptedProvider([{ text: 'Hello from the mock model.' }]);
    const engine = new PipelineEngine();
    const pipeline = buildPipeline();

    const ctx: PipelineContext = {
      cwd: dir,
      config: makeConfig(),
      provider,
      messages: [],
      systemPrompt: '',
      isReasoner: false,
      task: 'say hello',
      toolDefinitions: [],
      maxIterations: 5,
      iteration: 0,
      reasoningText: '',
      assistantText: '',
      toolCalls: [],
      finishReason: null,
      outputTokens: 0,
      hasReadThisTurn: false,
      warnedBlindWrite: false,
      language: 'en',
    };
    pushUserMessage(ctx, ctx.task);

    const result = await engine.execute(pipeline, ctx);

    expect(result.error).toBeUndefined();
    expect(result.done).toBe(true);
    expect(ctx.finishReason).toBe('stop');
    // Final assistant message must have been pushed to the message list.
    const lastMsg = ctx.messages[ctx.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect((lastMsg as { content: string }).content).toBe('Hello from the mock model.');
  });

  it('drives a real write_file tool call end to end: mock model emits tool_call_delta → real file written to tmp dir', async () => {
    const targetFile = join(dir, 'output.txt');
    const provider = createScriptedProvider([
      {
        toolCalls: [{
          id: 'call_1',
          name: 'write_file',
          arguments: JSON.stringify({ path: targetFile, content: 'written by the pipeline e2e test' }),
        }],
      },
      { text: 'Done — file written.' },
    ]);

    const engine = new PipelineEngine();
    const pipeline = buildPipeline();

    const ctx: PipelineContext = {
      cwd: dir,
      config: makeConfig(),
      provider,
      messages: [],
      systemPrompt: '',
      isReasoner: false,
      task: 'write a file',
      toolDefinitions: [],
      maxIterations: 5,
      iteration: 0,
      reasoningText: '',
      assistantText: '',
      toolCalls: [],
      finishReason: null,
      outputTokens: 0,
      hasReadThisTurn: false,
      warnedBlindWrite: false,
      language: 'en',
    };
    pushUserMessage(ctx, ctx.task);

    // First turn: model emits the write_file tool call. Pipeline stops after
    // ProcessToolCalls/PostProcess with finishReason 'tool_calls' (continue: true).
    const firstResult = await engine.execute(pipeline, ctx);
    expect(firstResult.error).toBeUndefined();
    expect(ctx.finishReason).toBe('tool_calls');

    // The real write_file tool must have actually written the file to disk.
    const written = await readFile(targetFile, 'utf-8');
    expect(written).toBe('written by the pipeline e2e test');

    // A tool result message must have been appended for the model to see.
    const toolResultMsg = ctx.messages.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(String((toolResultMsg as { content: string }).content)).toContain('output.txt');

    // Second turn (multi-turn case): feed the same context back through the
    // pipeline (skipping PrepareContext, matching how runGenerator drives
    // subsequent iterations) so the model can respond to the tool result.
    const secondPipeline = new PipelineBuilder()
      .name('e2e-test-turn-2')
      .addStage(new StreamResponseStage())
      .addStage(new ProcessToolCallsStage())
      .addStage(new PostProcessStage())
      .build();
    const secondResult = await engine.execute(secondPipeline, ctx);
    expect(secondResult.error).toBeUndefined();
    expect(ctx.finishReason).toBe('stop');
    const finalMsg = ctx.messages[ctx.messages.length - 1];
    expect((finalMsg as { content: string }).content).toBe('Done — file written.');
  });

  it('propagates a tool execution failure back into the conversation instead of crashing the pipeline', async () => {
    const provider = createScriptedProvider([
      {
        toolCalls: [{
          id: 'call_1',
          name: 'read_file',
          arguments: JSON.stringify({ path: join(dir, 'does-not-exist.txt') }),
        }],
      },
    ]);

    const engine = new PipelineEngine();
    const pipeline = buildPipeline();

    const ctx: PipelineContext = {
      cwd: dir,
      config: makeConfig(),
      provider,
      messages: [],
      systemPrompt: '',
      isReasoner: false,
      task: 'read a missing file',
      toolDefinitions: [],
      maxIterations: 5,
      iteration: 0,
      reasoningText: '',
      assistantText: '',
      toolCalls: [],
      finishReason: null,
      outputTokens: 0,
      hasReadThisTurn: false,
      warnedBlindWrite: false,
      language: 'en',
    };
    pushUserMessage(ctx, ctx.task);

    const result = await engine.execute(pipeline, ctx);
    expect(result.error).toBeUndefined(); // pipeline itself must not throw
    const toolResultMsg = ctx.messages.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(String((toolResultMsg as { content: string }).content).toLowerCase()).toContain('failed to read');
  });
});
