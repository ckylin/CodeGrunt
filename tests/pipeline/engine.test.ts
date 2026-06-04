import { describe, it, expect, vi } from 'vitest';
import { PipelineEngine, PipelineBuilder } from '../../src/core/pipeline/engine.js';
import type { Stage, StageResult, PipelineContext } from '../../src/core/pipeline/types.js';
import type { LLMProvider } from '../../src/types.js';

// ── Minimal stub PipelineContext ──────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stubProvider: LLMProvider = {
    id: 'stub',
    async *stream() { yield { type: 'finish', finish_reason: 'stop' }; },
  };
  return {
    cwd: '/tmp',
    config: {
      provider: 'stub', model: 'stub-model', maxTokens: 256,
      temperature: 0, apiKey: '', baseURL: '',
    },
    provider: stubProvider,
    messages: [],
    systemPrompt: '',
    isReasoner: false,
    task: 'test',
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
    ...overrides,
  };
}

// ── Stage factories ───────────────────────────────────────────────────────

function makeStage(name: string, result: StageResult, sideEffect?: (ctx: PipelineContext) => void): Stage {
  return {
    name,
    async execute(ctx) {
      sideEffect?.(ctx);
      return result;
    },
  };
}

function makeErrorStage(name: string): Stage {
  return {
    name,
    async execute() {
      throw new Error(`${name} exploded`);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PipelineEngine', () => {
  it('executes all stages in order', async () => {
    const order: string[] = [];
    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeStage('a', { continue: true, done: false }, () => order.push('a')))
      .addStage(makeStage('b', { continue: true, done: false }, () => order.push('b')))
      .addStage(makeStage('c', { continue: true, done: false }, () => order.push('c')))
      .build();

    const result = await engine.execute(pipeline, makeCtx());
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('stops early when a stage returns done: true', async () => {
    const order: string[] = [];
    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeStage('a', { continue: true, done: true }, () => order.push('a')))
      .addStage(makeStage('b', { continue: true, done: false }, () => order.push('b')))
      .build();

    await engine.execute(pipeline, makeCtx());
    expect(order).toEqual(['a']);
  });

  it('stops early when a stage returns continue: false', async () => {
    const order: string[] = [];
    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeStage('a', { continue: false, done: false }, () => order.push('a')))
      .addStage(makeStage('b', { continue: true, done: false }, () => order.push('b')))
      .build();

    await engine.execute(pipeline, makeCtx());
    expect(order).toEqual(['a']);
  });

  it('propagates userRejected and halts remaining stages', async () => {
    const order: string[] = [];
    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeStage('a', { continue: true, done: false, userRejected: true }, () => order.push('a')))
      .addStage(makeStage('b', { continue: true, done: false }, () => order.push('b')))
      .build();

    const result = await engine.execute(pipeline, makeCtx());
    expect(result.userRejected).toBe(true);
    expect(order).toEqual(['a']);
  });

  it('captures stage errors in result.error without throwing', async () => {
    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeErrorStage('boom'))
      .build();

    const result = await engine.execute(pipeline, makeCtx());
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('boom exploded');
  });

  it('stops at abort signal', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const engine = new PipelineEngine();
    const pipeline = new PipelineBuilder()
      .name('test')
      .addStage(makeStage('a', { continue: true, done: false }, () => order.push('a')))
      .build();

    await engine.execute(pipeline, makeCtx({ signal: controller.signal }));
    expect(order).toEqual([]);
  });

  it('calls beforeExecute and afterExecute lifecycle hooks', async () => {
    const log: string[] = [];
    const engine = new PipelineEngine();

    const stageWithHooks: Stage & {
      beforeExecute(ctx: PipelineContext): Promise<void>;
      afterExecute(ctx: PipelineContext): Promise<void>;
    } = {
      name: 'hooked',
      async beforeExecute() { log.push('before'); },
      async execute() { log.push('execute'); return { continue: true, done: false }; },
      async afterExecute() { log.push('after'); },
    };

    const pipeline = new PipelineBuilder().name('test').addStage(stageWithHooks).build();
    await engine.execute(pipeline, makeCtx());
    expect(log).toEqual(['before', 'execute', 'after']);
  });
});

// ── PipelineBuilder ───────────────────────────────────────────────────────

describe('PipelineBuilder', () => {
  it('builds a pipeline with the given name and stages', () => {
    const s1 = makeStage('s1', { continue: true, done: false });
    const s2 = makeStage('s2', { continue: true, done: false });
    const pipeline = new PipelineBuilder().name('my-pipe').addStages([s1, s2]).build();
    expect(pipeline.name).toBe('my-pipe');
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0].name).toBe('s1');
  });
});
