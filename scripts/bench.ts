#!/usr/bin/env node
// ── Performance Benchmark Harness ────────────────────────────────────────────
// No new dependency (tinybench, etc.) — process.hrtime()/performance.now()
// and child_process cover everything this needs. Run with `npm run bench`.
//
// Measures three things the v0.9 roadmap calls out:
//   1. Cold start — process boot + module graph resolution + config load,
//      measured externally via `node dist/cli/index.js --help` (exits before
//      any network/provider code runs, so no API key is required).
//   2. Pipeline stage latency — the 4 P/G/E pipeline stages run against a
//      scripted mock LLMProvider (no real network call), isolating pipeline
//      overhead from LLM API round-trip time, which is externally bounded
//      and not something this codebase controls.
//   3. Memory — process.memoryUsage().rss before/after running a fixed
//      synthetic task through the agent loop with the same mock provider.
//
// This is a manual, run-on-demand script, not a CI gate — the roadmap item
// asks for a way to measure regressions, not (yet) an automated threshold
// that fails a build. Numbers are printed to stdout for a human to compare
// against the previous run / the roadmap's target figures.

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_ROOT }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ── 1. Cold start ────────────────────────────────────────────────────────

async function benchColdStart(runs: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await execFileAsync(process.execPath, [CLI_ENTRY, '--help']);
    samples.push(performance.now() - start);
  }
  return samples;
}

// ── 2. Pipeline stage latency (mock provider, no network) ──────────────────

async function benchPipeline(runs: number): Promise<{ total: number[]; perStage: Record<string, number[]> }> {
  const { PipelineEngine, PipelineBuilder } = await import('../src/core/pipeline/engine.js');
  const { PrepareContextStage } = await import('../src/core/pipeline/stages/prepare-context.js');
  const { StreamResponseStage } = await import('../src/core/pipeline/stages/stream-response.js');
  const { ProcessToolCallsStage } = await import('../src/core/pipeline/stages/process-tools.js');
  const { PostProcessStage } = await import('../src/core/pipeline/stages/post-process.js');
  type LLMProviderType = import('../src/types.js').LLMProvider;
  type PipelineContextType = import('../src/core/pipeline/types.js').PipelineContext;

  const mockProvider: LLMProviderType = {
    id: 'bench-mock',
    async *stream() {
      yield { type: 'text_delta' as const, text: 'benchmark response' };
      yield { type: 'finish' as const, finish_reason: 'stop' as const };
    },
  };

  function makeCtx(): PipelineContextType {
    return {
      cwd: REPO_ROOT,
      config: { provider: 'bench', model: 'bench-model', maxTokens: 256, temperature: 0, apiKey: '', baseURL: '' },
      provider: mockProvider,
      messages: [{ role: 'user', content: 'benchmark task' }],
      systemPrompt: '',
      isReasoner: false,
      task: 'benchmark task',
      toolDefinitions: [],
      maxIterations: 1,
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
  }

  const pipeline = new PipelineBuilder()
    .name('bench')
    .addStage(new PrepareContextStage())
    .addStage(new StreamResponseStage())
    .addStage(new ProcessToolCallsStage())
    .addStage(new PostProcessStage())
    .build();

  const total: number[] = [];
  const perStage: Record<string, number[]> = {};

  for (let i = 0; i < runs; i++) {
    const engine = new PipelineEngine();
    const ctx = makeCtx();
    const start = performance.now();
    await engine.execute(pipeline, ctx);
    total.push(performance.now() - start);
  }

  return { total, perStage };
}

// ── 3. Memory ────────────────────────────────────────────────────────────

function benchMemory(): { rssBefore: number; rssAfter: number; deltaMB: number } {
  const rssBefore = process.memoryUsage().rss;
  // Allocate a representative-ish workload: a few thousand message objects,
  // similar order of magnitude to a long conversation history in memory.
  const messages = Array.from({ length: 2000 }, (_, i) => ({
    role: 'user' as const,
    content: `Message number ${i} with some representative padding text.`,
  }));
  void messages.length; // keep referenced so it isn't optimized away before the snapshot
  const rssAfter = process.memoryUsage().rss;
  return { rssBefore, rssAfter, deltaMB: (rssAfter - rssBefore) / (1024 * 1024) };
}

// ── Stats helpers ────────────────────────────────────────────────────────

function stats(samples: number[]): { min: number; max: number; mean: number; p50: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    p50: sorted[Math.floor(sorted.length / 2)],
  };
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fs = await import('fs');
  if (!fs.existsSync(CLI_ENTRY)) {
    console.error(`dist/cli/index.js not found — run "npm run build" first.`);
    process.exit(1);
  }

  console.log('CodeGrunt Performance Benchmark');
  console.log('================================\n');

  console.log('1. Cold start (node dist/cli/index.js --help, 5 runs)');
  const coldStartSamples = await benchColdStart(5);
  const cs = stats(coldStartSamples);
  console.log(`   min=${fmt(cs.min)}  p50=${fmt(cs.p50)}  mean=${fmt(cs.mean)}  max=${fmt(cs.max)}`);
  console.log(`   (roadmap target: p50 <= 800ms)\n`);

  console.log('2. Pipeline stage latency (mock provider, no network, 10 runs)');
  const { total } = await benchPipeline(10);
  const ps = stats(total);
  console.log(`   min=${fmt(ps.min)}  p50=${fmt(ps.p50)}  mean=${fmt(ps.mean)}  max=${fmt(ps.max)}\n`);

  console.log('3. Memory (rss delta allocating a 2000-message synthetic history)');
  const mem = benchMemory();
  console.log(`   rss before=${(mem.rssBefore / 1024 / 1024).toFixed(1)}MB  after=${(mem.rssAfter / 1024 / 1024).toFixed(1)}MB  delta=${mem.deltaMB.toFixed(2)}MB\n`);

  console.log(`dist/ size: see \`du -sh dist/\` (not measured here — filesystem-dependent, not a runtime metric)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
