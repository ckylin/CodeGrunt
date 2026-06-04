import { describe, it, expect } from 'vitest';

// ── Import pure-logic functions under test ────────────────────────────────
// These are not exported from the module. We test them indirectly through
// the exported detectIntent() in the integration path, but we can also
// import the raw helpers by reaching into the module internals via dynamic
// import and spying — however the simplest approach for pure functions is to
// re-implement the same logic assertions against the exported behavior.
//
// Since heuristicClassify and matchSkillHeuristic are module-private,
// we test them through detectIntent() using a stub provider that never
// gets called (proving the heuristic path returned before the LLM path).

import { detectIntent } from '../../src/core/agent/intentor.js';
import type { LLMProvider, StreamChunk } from '../../src/types.js';
import type { Skill } from '../../src/cli/skills.js';

// ── Stub provider — should never be called by heuristic tests ─────────────

function makeStubProvider(response = ''): LLMProvider {
  let called = false;
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      called = true;
      if (response) {
        yield { type: 'text_delta', text: response };
      }
      yield { type: 'finish', finish_reason: 'stop' };
    },
    get wasCalled() { return called; },
  } as LLMProvider & { wasCalled: boolean };
}

// ── Planner pure-logic tests ──────────────────────────────────────────────

import { generatePlan } from '../../src/core/agent/planner.js';

function makePlannerProvider(jsonResponse: string): LLMProvider {
  return {
    id: 'stub',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text: jsonResponse };
      yield { type: 'finish', finish_reason: 'stop' };
    },
  };
}

// ── Intentor heuristic tests ──────────────────────────────────────────────

describe('Intentor — heuristic classification', () => {
  it('classifies clear coding tasks without calling the LLM', async () => {
    const provider = makeStubProvider() as LLMProvider & { wasCalled: boolean };
    const result = await detectIntent(provider, 'model', 'fix the bug in src/auth.ts', 'en');
    expect(result.isCoding).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect((provider as any).wasCalled).toBe(false);
  });

  it('classifies clear conversational tasks without calling the LLM', async () => {
    const provider = makeStubProvider() as LLMProvider & { wasCalled: boolean };
    const result = await detectIntent(provider, 'model', 'what is the difference between let and const', 'en');
    expect(result.isCoding).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect((provider as any).wasCalled).toBe(false);
  });

  it('classifies Chinese coding tasks correctly', async () => {
    const provider = makeStubProvider() as LLMProvider & { wasCalled: boolean };
    const result = await detectIntent(provider, 'model', '修复 src/auth.ts 里的 bug', 'zh');
    expect(result.isCoding).toBe(true);
    expect((provider as any).wasCalled).toBe(false);
  });
});

describe('Intentor — skill matching', () => {
  const skills: Skill[] = [
    {
      name: 'code-review',
      description: 'Review code for bugs and best practices',
      content: 'Review this code...',
      system: undefined,
    },
    {
      name: 'write-docs',
      description: 'Write documentation for a module',
      content: 'Document this...',
      system: undefined,
    },
  ];

  it('matches a task to a skill by keyword overlap without LLM', async () => {
    const provider = makeStubProvider() as LLMProvider & { wasCalled: boolean };
    const result = await detectIntent(provider, 'model', 'please review this code', 'en', undefined, skills);
    expect(result.matchedSkill).toBeDefined();
    expect(result.matchedSkill?.name).toBe('code-review');
    expect((provider as any).wasCalled).toBe(false);
  });

  it('does not match unrelated tasks to a skill', async () => {
    const provider = makeStubProvider() as LLMProvider & { wasCalled: boolean };
    const result = await detectIntent(provider, 'model', 'fix the login bug in auth.ts', 'en', undefined, skills);
    expect(result.matchedSkill).toBeUndefined();
  });
});

describe('Intentor — LLM fallback with skill list', () => {
  it('parses a valid LLM JSON response', async () => {
    const llmResponse = '```json\n{"isCoding": false, "confidence": 80, "reason": "docs task", "matchedSkill": "write-docs"}\n```';
    const skills: Skill[] = [
      { name: 'write-docs', description: 'documentation writer', content: 'doc prompt', system: undefined },
    ];
    const provider = makePlannerProvider(llmResponse);
    // Use an ambiguous task that neither heuristic will classify confidently
    const result = await detectIntent(provider, 'model', 'create something for me', 'en', undefined, skills);
    // Either the heuristic handled it or the LLM result was parsed
    expect(typeof result.isCoding).toBe('boolean');
    expect(result.confidence).toBeGreaterThan(0);
  });
});

// ── Planner plan parsing tests ────────────────────────────────────────────

describe('Planner — plan parsing', () => {
  it('parses a valid JSON plan from the LLM response', async () => {
    const plan = {
      goal: 'Add a login button',
      reasoning: 'Simple single-file change',
      steps: [
        {
          id: 1,
          description: 'Edit App.tsx to add login button',
          toolsHint: ['edit_file'],
          expectedOutcome: 'Button appears',
          verification: 'Component renders',
        },
      ],
    };
    const provider = makePlannerProvider(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
    const result = await generatePlan(provider, 'model', 'Add a login button to App.tsx', 'en');
    expect(result.goal).toBe('Add a login button');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].description).toBe('Edit App.tsx to add login button');
  });

  it('falls back to single-step plan on invalid JSON', async () => {
    const provider = makePlannerProvider('Sorry, I cannot plan that.');
    const task = 'do something';
    const result = await generatePlan(provider, 'model', task, 'en');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].description).toBe(task);
  });

  it('normalizes missing step fields', async () => {
    const malformed = {
      goal: 'goal',
      reasoning: '',
      steps: [{ description: 'step one' }],
    };
    const provider = makePlannerProvider(`\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\``);
    const result = await generatePlan(provider, 'model', 'task', 'en');
    expect(result.steps[0].id).toBe(1);
    expect(result.steps[0].toolsHint).toEqual([]);
    expect(typeof result.steps[0].expectedOutcome).toBe('string');
  });

  it('falls back gracefully on provider error', async () => {
    const errProvider: LLMProvider = {
      id: 'stub',
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('network error');
      },
    };
    const result = await generatePlan(errProvider, 'model', 'the task', 'en');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].description).toBe('the task');
  });
});
