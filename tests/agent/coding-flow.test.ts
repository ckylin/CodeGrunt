import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { join } from 'path';

vi.mock('../../src/core/agent/planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/agent/planner.js')>();
  return { ...actual, generatePlan: vi.fn() };
});
vi.mock('../../src/core/agent/orchestrator.js', () => ({ runOrchestrator: vi.fn() }));
vi.mock('../../src/utils/confirm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/confirm.js')>();
  return { ...actual, confirmYesNo: vi.fn(), confirmEdit: vi.fn(), confirmShellCommand: vi.fn() };
});

import { runCodingFlow, pruneRefineMessages, createStepRunState } from '../../src/core/agent/coding-flow.js';
import { generatePlan } from '../../src/core/agent/planner.js';
import { runOrchestrator } from '../../src/core/agent/orchestrator.js';
import { confirmYesNo } from '../../src/utils/confirm.js';
import { getDefaultEventBus } from '../../src/core/events/bus.js';
import { setTrustMode } from '../../src/core/policy/state.js';
import { ContextManager } from '../../src/core/context/manager.js';
import { createScriptedProvider, type ScriptedTurn } from '../helpers/mock-provider.js';
import { setupFlowEnv, makeOptions, newContext, metrics, outputOf, type FlowEnv } from './_flow-harness.js';
import type { IntentResult, TaskPlan } from '../../src/core/pipeline/types.js';

const intent: IntentResult = { isCoding: true, confidence: 90, reason: 'test' };
const generatePlanMock = vi.mocked(generatePlan);
const orchestratorMock = vi.mocked(runOrchestrator);
const confirmYesNoMock = vi.mocked(confirmYesNo);

const LONG_TASK = 'Please implement the feature described across several files and then verify the result carefully';

const twoStepPlan: TaskPlan = {
  goal: 'two steps',
  reasoning: 'r',
  steps: [
    { id: 1, description: 'first thing', toolsHint: [], expectedOutcome: 'a', verification: 'v' },
    { id: 2, description: 'second thing', toolsHint: [], expectedOutcome: 'b', verification: 'v' },
  ],
};

const missingRead = (id: string, dir: string): ScriptedTurn => ({
  toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: join(dir, 'missing.txt') }) }],
});

const run = (env: FlowEnv, provider: ReturnType<typeof createScriptedProvider>, task: string, context = newContext(), extra = {}) =>
  runCodingFlow(makeOptions(env, provider, task, extra), context, 'en', intent, metrics(), getDefaultEventBus());

describe('runCodingFlow (characterization)', () => {
  let env: FlowEnv;

  beforeEach(async () => {
    env = await setupFlowEnv();
    generatePlanMock.mockReset();
    orchestratorMock.mockReset();
    confirmYesNoMock.mockReset();
  });
  afterEach(async () => { await env.cleanup(); });

  describe('planning', () => {
    it('skips the planner for a short task and runs it as a single step', async () => {
      const provider = createScriptedProvider([{ text: 'Done.' }]);
      const result = await run(env, provider, 'fix the typo');
      expect(generatePlanMock).not.toHaveBeenCalled();
      expect(result.responseLength).toBe('Done.'.length);
      expect(provider.calls).toHaveLength(1);
      const user = provider.calls[0].messages.find((m) => m.role === 'user') as { content: string };
      expect(user.content).toContain('Step 1/1: fix the typo');
      expect(user.content).toContain('## Background Context\nfix the typo');
    });

    it('treats a bare continuation word as "continue the previous task" without planning', async () => {
      const provider = createScriptedProvider([{ text: 'Continued.' }]);
      await run(env, provider, 'continue');
      expect(generatePlanMock).not.toHaveBeenCalled();
      const user = provider.calls[0].messages.find((m) => m.role === 'user') as { content: string };
      expect(user.content).toContain('Continue the previous task and complete remaining steps');
    });

    it('uses the planner for a long task and runs each planned step in order', async () => {
      generatePlanMock.mockResolvedValue(twoStepPlan);
      const provider = createScriptedProvider([{ text: 'step one done' }, { text: 'step two done!' }]);
      const result = await run(env, provider, LONG_TASK);

      expect(generatePlanMock).toHaveBeenCalledTimes(1);
      expect(provider.calls).toHaveLength(2);
      const userMsgs = (i: number) => provider.calls[i].messages.filter((m) => m.role === 'user').map((m) => String(m.content));
      expect(userMsgs(0).join('\n')).toContain('Step 1/2: first thing');
      expect(userMsgs(1).join('\n')).toContain('Step 2/2: second thing');
      expect(result.responseLength).toBe('step two done!'.length); // last passing step's text
      expect(outputOf(env)).not.toContain('All steps executed');
    });

    it('falls back to one step with the raw task when the planner throws', async () => {
      generatePlanMock.mockRejectedValue(new Error('planner down'));
      const provider = createScriptedProvider([{ text: 'handled' }]);
      const result = await run(env, provider, LONG_TASK);
      expect(provider.calls).toHaveLength(1);
      const user = provider.calls[0].messages.find((m) => m.role === 'user') as { content: string };
      expect(user.content).toContain(`Step 1/1: ${LONG_TASK}`);
      expect(result.responseLength).toBe('handled'.length);
    });

    it('hands plans with a parallelizable step to the orchestrator and returns its text length', async () => {
      generatePlanMock.mockResolvedValue({
        ...twoStepPlan,
        steps: twoStepPlan.steps.map((s) => ({ ...s, parallelizable: true })),
      });
      orchestratorMock.mockResolvedValue({ finalAssistantText: 'orchestrated', userRejected: false } as never);
      const provider = createScriptedProvider([{ text: 'must not be called' }]);
      const result = await run(env, provider, LONG_TASK);
      expect(orchestratorMock).toHaveBeenCalledTimes(1);
      expect(provider.calls).toHaveLength(0);
      expect(result.responseLength).toBe('orchestrated'.length);
    });

    it('returns 0 when the orchestrator reports a user rejection', async () => {
      generatePlanMock.mockResolvedValue({
        ...twoStepPlan,
        steps: twoStepPlan.steps.map((s) => ({ ...s, parallelizable: true })),
      });
      orchestratorMock.mockResolvedValue({ finalAssistantText: 'x', userRejected: true } as never);
      const result = await run(env, createScriptedProvider([{ text: 'n/a' }]), LONG_TASK);
      expect(result.responseLength).toBe(0);
    });
  });

  describe('tool iteration inside a step', () => {
    it('runs tool calls, feeds results back, and ends on the final text', async () => {
      await writeFile(join(env.dir, 'f.txt'), 'file-body');
      const provider = createScriptedProvider([
        { toolCalls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'f.txt' }) }] },
        { text: 'It contains file-body.' },
      ]);
      const onToolResult = vi.fn();
      const context = newContext();
      const result = await run(env, provider, 'read f.txt', context, { onToolResult });
      expect(provider.calls).toHaveLength(2);
      expect(onToolResult.mock.calls[0][1].output).toContain('file-body');
      expect(result.responseLength).toBe('It contains file-body.'.length);
      expect(context.getMessages().some((m) => m.role === 'tool')).toBe(true);
    });

    it('prints the generic summary when the step passes but produced no final text', async () => {
      await writeFile(join(env.dir, 'f.txt'), 'x');
      const provider = createScriptedProvider([
        { toolCalls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'f.txt' }) }] },
        { finishReason: 'stop' },
      ]);
      const result = await run(env, provider, 'read f.txt');
      expect(result.responseLength).toBe(0);
      expect(outputOf(env)).toContain('All steps executed. Review the tool outputs above for results.');
    });

    it('does nothing and prints the summary when the signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const provider = createScriptedProvider([{ text: 'never' }]);
      const result = await run(env, provider, 'fix the typo', newContext(), { signal: ac.signal });
      expect(provider.calls).toHaveLength(0);
      expect(result.responseLength).toBe(0);
      expect(outputOf(env)).toContain('All steps executed');
    });

    it('ends with 0 when a tool call is rejected (plan mode) and does not run later steps', async () => {
      setTrustMode('plan');
      generatePlanMock.mockResolvedValue(twoStepPlan);
      const provider = createScriptedProvider([
        { toolCalls: [{ id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'o.txt', content: 'x' }) }] },
        { text: 'unreachable' },
      ]);
      const result = await run(env, provider, LONG_TASK);
      expect(result.responseLength).toBe(0);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('evaluate / refine loop', () => {
    // KNOWN QUIRK (pinned as-is, not endorsed): toolMsgCountBefore is taken
    // AFTER the step's first generator turn, so tool results from that first
    // turn are never shown to the evaluator. A failing tool call must happen in
    // an inner iteration (turn 2+) to trigger a retry. If this is fixed on
    // purpose, flip this test.
    it('does not evaluate tool failures from the first generator turn of a step', async () => {
      const provider = createScriptedProvider([missingRead('q1', env.dir), { text: 'moved on' }]);
      const result = await run(env, provider, 'read the missing file');
      expect(provider.calls).toHaveLength(2);
      expect(result.responseLength).toBe('moved on'.length);
      expect(confirmYesNoMock).not.toHaveBeenCalled();
    });

    // One attempt = 3 provider calls: an OK read (turn 1, not evaluated), a
    // failing read (inner iteration, evaluated), then closing text.
    const attempt = (n: number, dir: string): ScriptedTurn[] => [
      { toolCalls: [{ id: `ok${n}`, name: 'read_file', arguments: JSON.stringify({ path: join(dir, 'ok.txt') }) }] },
      missingRead(`bad${n}`, dir),
      { text: `attempt ${n}` },
    ];

    it('retries after a failed tool result, then passes and prunes the feedback message', async () => {
      await writeFile(join(env.dir, 'ok.txt'), 'fine');
      const provider = createScriptedProvider([...attempt(1, env.dir), { text: 'fixed' }]);
      const context = newContext();
      const result = await run(env, provider, 'read the missing file', context);

      expect(provider.calls).toHaveLength(4);
      expect(result.responseLength).toBe('fixed'.length);
      // The retry request carried the evaluation feedback...
      const retryUsers = provider.calls[3].messages.filter((m) => m.role === 'user').map((m) => String(m.content));
      expect(retryUsers.some((t) => t.startsWith('[Evaluation Feedback]'))).toBe(true);
      expect(retryUsers.join('\n')).toContain('RETRY Step 1');
      // ...and it is gone from the context after the step passed.
      expect(context.getMessages().some((m) => String(m.content).startsWith('[Evaluation Feedback]'))).toBe(false);
      expect(confirmYesNoMock).not.toHaveBeenCalled();
    });

    const alwaysFailing = (dir: string): ScriptedTurn[] =>
      [1, 2, 3, 4].flatMap((n) => attempt(n, dir));

    it('after 4 failed attempts asks whether to continue; "no" ends the flow with 0', async () => {
      await writeFile(join(env.dir, 'ok.txt'), 'fine');
      confirmYesNoMock.mockResolvedValue(false);
      const provider = createScriptedProvider(alwaysFailing(env.dir));
      const context = newContext();
      const result = await run(env, provider, 'read the missing file', context);
      expect(provider.calls).toHaveLength(12); // 1 initial + 3 retries, 3 provider calls each
      expect(confirmYesNoMock).toHaveBeenCalledTimes(1);
      expect(String(confirmYesNoMock.mock.calls[0][0])).toContain('failed after 3 retries');
      expect(result.responseLength).toBe(0);
      expect(context.getMessages().some((m) => String(m.content).startsWith('[Evaluation Feedback]'))).toBe(false);
    });

    it('after 4 failed attempts "yes" continues, records a warning, and keeps the last text', async () => {
      await writeFile(join(env.dir, 'ok.txt'), 'fine');
      confirmYesNoMock.mockResolvedValue(true);
      const provider = createScriptedProvider(alwaysFailing(env.dir));
      const context = newContext();
      const result = await run(env, provider, 'read the missing file', context);
      expect(result.responseLength).toBe('attempt 4'.length);
      expect(context.getMessages().some((m) => String(m.content).startsWith('[WARNING: step 1 may be incomplete'))).toBe(true);
    });
  });

  describe('helpers', () => {
    it('pruneRefineMessages removes only evaluation-feedback user messages (both languages)', () => {
      const ctx = new ContextManager();
      ctx.push({ role: 'user', content: 'real request' });
      ctx.push({ role: 'user', content: '[Evaluation Feedback] fix it' });
      ctx.push({ role: 'user', content: '[评估反馈] 请修正' });
      ctx.push({ role: 'assistant', content: '[Evaluation Feedback] quoted by the assistant' });
      pruneRefineMessages(ctx);
      expect(ctx.getMessages().map((m) => m.content)).toEqual([
        'real request',
        '[Evaluation Feedback] quoted by the assistant',
      ]);
    });

    it('createStepRunState starts fresh', () => {
      const s = createStepRunState();
      expect(s.sessionHasRead).toBe(false);
      expect(s.globalIter).toBe(0);
      expect(s.prepareStage).toBeDefined();
    });
  });
});
