import { describe, it, expect } from 'vitest';
import {
  isDeepSeekModel, isDeepSeekV4Model, fastModelFor, isReasonerModel, supportsReasoning,
} from '../../src/providers/model-policy.js';
import * as config from '../../src/config.js';
import { selectCompactModel } from '../../src/core/context/compact.js';
import { selectModelForTask } from '../../src/core/agent/intentor.js';

// Expected values are what the scattered `startsWith('deepseek-')` / includes()
// checks produced before they were centralized.
const MODELS = [
  // id,                  deepseek, v4,    fast model,           reasoner, supportsReasoning
  ['deepseek-chat',       true,     false, 'deepseek-v4-flash',  false,    false],
  ['deepseek-v4-flash',   true,     true,  'deepseek-v4-flash',  false,    true],
  ['deepseek-v4-pro',     true,     true,  'deepseek-v4-flash',  false,    true],
  ['deepseek-reasoner',   true,     false, 'deepseek-v4-flash',  true,     true],
  ['gpt-4o',              false,    false, 'gpt-4o',             false,    false],
] as const;

describe('model-policy', () => {
  it.each(MODELS)('%s', (id, deepseek, v4, fast, reasoner, reasoning) => {
    expect(isDeepSeekModel(id)).toBe(deepseek);
    expect(isDeepSeekV4Model(id)).toBe(v4);
    expect(fastModelFor(id)).toBe(fast);
    expect(isReasonerModel(id)).toBe(reasoner);
    expect(supportsReasoning(id)).toBe(reasoning);
  });

  it('matches reasoner ids case-insensitively and by "r1"', () => {
    expect(isReasonerModel('DeepSeek-R1')).toBe(true);
    expect(isReasonerModel('DEEPSEEK-REASONER')).toBe(true);
  });

  it('config.ts still re-exports the reasoning predicates', () => {
    expect(config.isReasonerModel).toBe(isReasonerModel);
    expect(config.supportsReasoning).toBe(supportsReasoning);
  });

  it.each(MODELS)('selectCompactModel(%s) uses the shared downgrade', (id, _d, _v4, fast) => {
    expect(selectCompactModel(id)).toBe(fast);
  });
});

describe('selectModelForTask routing stays inside the V4 tier', () => {
  const coding = { isCoding: true, confidence: 90, reason: '' };

  it('leaves non-V4 models alone', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o']) {
      expect(selectModelForTask(id, 'a'.repeat(200), coding)).toBe(id);
    }
  });

  it('routes V4 models: non-coding and short tasks to flash', () => {
    expect(selectModelForTask('deepseek-v4-pro', 'what is a closure', { ...coding, isCoding: false })).toBe('deepseek-v4-flash');
    expect(selectModelForTask('deepseek-v4-pro', 'fix typo', coding)).toBe('deepseek-v4-flash');
  });
});
