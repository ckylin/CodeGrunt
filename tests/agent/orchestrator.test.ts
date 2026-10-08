import { describe, it, expect, beforeEach } from 'vitest';
import { groupIntoBatches, runOrchestrator } from '../../src/core/agent/orchestrator.js';
import { setSubagentContext } from '../../src/core/agent/subagent.js';
import { clearSubagentCache } from '../../src/core/agent/subagent-cache.js';
import { ContextManager } from '../../src/core/context/manager.js';
import type { PlanStep, TaskPlan } from '../../src/core/pipeline/types.js';
import type { AgentRunOptions, LLMProvider, StreamChunk } from '../../src/types.js';

function makeStep(overrides: Partial<PlanStep>): PlanStep {
  return {
    id: 1,
    description: 'do something',
    toolsHint: [],
    expectedOutcome: 'done',
    verification: 'no errors',
    ...overrides,
  };
}

describe('groupIntoBatches', () => {
  it('puts every non-parallelizable step in its own serial batch, preserving order', () => {
    const steps = [
      makeStep({ id: 1, parallelizable: false }),
      makeStep({ id: 2, parallelizable: false }),
    ];
    const batches = groupIntoBatches(steps);
    expect(batches).toEqual([
      { steps: [steps[0]], mode: 'serial' },
      { steps: [steps[1]], mode: 'serial' },
    ]);
  });

  it('groups consecutive parallelizable steps with disjoint targetFiles into one parallel batch', () => {
    const steps = [
      makeStep({ id: 1, parallelizable: true, targetFiles: ['a.ts'] }),
      makeStep({ id: 2, parallelizable: true, targetFiles: ['b.ts'] }),
    ];
    const batches = groupIntoBatches(steps);
    expect(batches).toHaveLength(1);
    expect(batches[0].mode).toBe('parallel');
    expect(batches[0].steps.map(s => s.id)).toEqual([1, 2]);
  });

  it('demotes a parallelizable step with no declared targetFiles to serial (conservative default)', () => {
    const steps = [
      makeStep({ id: 1, parallelizable: true, targetFiles: [] }),
      makeStep({ id: 2, parallelizable: true, targetFiles: ['b.ts'] }),
    ];
    const batches = groupIntoBatches(steps);
    // Step 1 has no targetFiles -> forced serial; step 2 alone -> also serial (single-step "batch")
    expect(batches).toEqual([
      { steps: [steps[0]], mode: 'serial' },
      { steps: [steps[1]], mode: 'serial' },
    ]);
  });

  it('demotes an overlapping step to a serial batch that runs after the parallel group', () => {
    const steps = [
      makeStep({ id: 1, parallelizable: true, targetFiles: ['shared.ts'] }),
      makeStep({ id: 2, parallelizable: true, targetFiles: ['shared.ts'] }),
      makeStep({ id: 3, parallelizable: true, targetFiles: ['c.ts'] }),
    ];
    const batches = groupIntoBatches(steps);
    // Step 1 claims shared.ts first; step 3 has no conflict -> both go in one
    // parallel batch. Step 2 overlaps shared.ts -> demoted, runs serially
    // AFTER the parallel batch (not interleaved back into position 2).
    expect(batches).toEqual([
      { steps: [steps[0], steps[2]], mode: 'parallel' },
      { steps: [steps[1]], mode: 'serial' },
    ]);
  });

  it('handles a mix of serial and parallel runs in plan order', () => {
    const steps = [
      makeStep({ id: 1, parallelizable: false }),
      makeStep({ id: 2, parallelizable: true, targetFiles: ['a.ts'] }),
      makeStep({ id: 3, parallelizable: true, targetFiles: ['b.ts'] }),
      makeStep({ id: 4, parallelizable: false }),
    ];
    const batches = groupIntoBatches(steps);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual({ steps: [steps[0]], mode: 'serial' });
    expect(batches[1].mode).toBe('parallel');
    expect(batches[1].steps.map(s => s.id)).toEqual([2, 3]);
    expect(batches[2]).toEqual({ steps: [steps[3]], mode: 'serial' });
  });
});

// ── runOrchestrator integration (stub providers, no real LLM) ──────────────

function makeTextProvider(text: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

function baseOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    task: 'do the parallel task',
    cwd: process.cwd(),
    config: { provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 4096, temperature: 0.2, apiKey: 'x', baseURL: 'https://x' },
    provider: makeTextProvider('ok'),
    ...overrides,
  };
}

describe('runOrchestrator', () => {
  beforeEach(() => {
    clearSubagentCache();
  });

  it('dispatches a parallel batch to workers and reports success for both steps', async () => {
    const provider = makeTextProvider('worker done');
    setSubagentContext(provider, 'deepseek-v4-pro');

    const plan: TaskPlan = {
      goal: 'update two files',
      reasoning: 'independent files',
      steps: [
        makeStep({ id: 1, description: 'update a.ts', parallelizable: true, targetFiles: ['a.ts'] }),
        makeStep({ id: 2, description: 'update b.ts', parallelizable: true, targetFiles: ['b.ts'] }),
      ],
    };

    const context = new ContextManager(90_000);
    const options = baseOptions({ provider });
    const result = await runOrchestrator(plan, options, context, 'en');

    expect(result.userRejected).toBe(false);
    expect(result.stepStatuses).toEqual(['done', 'done']);
    expect(result.finalAssistantText).toBe('worker done');
  });

  it('propagates a generator error from the serial retry of a failed parallel step (same as the pre-existing sequential path)', async () => {
    // The worker's own provider fails inside runSubagent, which catches
    // provider errors and reports a failed SubagentResult (no throw) — but
    // the *serial retry* of that failed step goes through the real
    // generator/pipeline, which does NOT swallow a persistent stream error;
    // after MAX_REFINE_RETRIES it re-throws, exactly like the original
    // (pre-Orchestrator) sequential loop in coding-flow.ts always did.
    const plan: TaskPlan = {
      goal: 'update two files',
      reasoning: 'independent files',
      steps: [
        makeStep({ id: 1, description: 'update a.ts', parallelizable: true, targetFiles: ['a.ts'] }),
        makeStep({ id: 2, description: 'update b.ts', parallelizable: true, targetFiles: ['b.ts'] }),
      ],
    };

    const provider: LLMProvider = {
      id: 'stub',
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('boom');
      },
    };
    setSubagentContext(provider, 'deepseek-v4-pro');

    const context = new ContextManager(90_000);
    const options = baseOptions({ provider });

    await expect(runOrchestrator(plan, options, context, 'en')).rejects.toThrow('boom');
  });
});
