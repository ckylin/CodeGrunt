import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyConfig, contextBudgetFor } from '../../src/cli/repl/apply-config.js';
import { CONTEXT_BUDGET, CHAT_CONTEXT_BUDGET } from '../../src/config.js';
import { ACCENT } from '../../src/utils/constants.js';
import type { CodeGruntConfig } from '../../src/types.js';

const base = { model: 'deepseek-v4-pro' } as unknown as CodeGruntConfig;

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env['CODEGRUNT_SEARCH_ENGINE'];
  delete process.env['CODEGRUNT_SEARXNG_URL'];
});

describe('contextBudgetFor', () => {
  it('gives reasoning-capable models the larger budget and chat models the smaller one', () => {
    expect(contextBudgetFor({ model: 'deepseek-v4-pro' })).toBe(CONTEXT_BUDGET);
    expect(contextBudgetFor({ model: 'deepseek-chat' })).toBe(CHAT_CONTEXT_BUDGET);
  });
});

describe('applyConfig', () => {
  it('exports the search engine and SearXNG url to env for tools to read', () => {
    applyConfig({ ...base, searchEngine: 'searxng', searxngUrl: 'http://localhost:8080' } as CodeGruntConfig);
    expect(process.env['CODEGRUNT_SEARCH_ENGINE']).toBe('searxng');
    expect(process.env['CODEGRUNT_SEARXNG_URL']).toBe('http://localhost:8080');
  });

  it('leaves env untouched when those settings are absent', () => {
    process.env['CODEGRUNT_SEARCH_ENGINE'] = 'mojeek';
    applyConfig(base);
    expect(process.env['CODEGRUNT_SEARCH_ENGINE']).toBe('mojeek');
    expect(process.env['CODEGRUNT_SEARXNG_URL']).toBeUndefined();
  });

  it('applies the theme (defaulting to dark)', () => {
    applyConfig({ ...base, theme: 'light' } as CodeGruntConfig);
    const light = ACCENT;
    applyConfig({ ...base, theme: 'dark' } as CodeGruntConfig);
    expect(ACCENT).not.toBe(light);
  });
});
