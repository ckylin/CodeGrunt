import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every module that talks to the network, the user's home, or an LLM is stubbed
// so the dispatch table itself can be exercised for every command.
vi.mock('../../src/utils/select.js', () => ({ selectFromList: vi.fn(async () => null) }));
vi.mock('../../src/utils/pager.js', () => ({ printPaged: vi.fn(async (t: string) => { console.log(t); }) }));
vi.mock('../../src/utils/billing.js', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/billing.js')>();
  return {
    ...actual,
    printBalanceAndUsage: vi.fn(async () => {}),
    getTodayUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cost: 0 })),
    getMonthUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cost: 0 })),
  };
});
vi.mock('../../src/cli/init.js', () => ({ runInit: vi.fn(async () => {}) }));
vi.mock('../../src/core/memory/store.js', () => ({
  saveSessionSummary: vi.fn(), loadSessionSummary: vi.fn(async () => null),
  deleteEntry: vi.fn(), listEntries: vi.fn(async () => []),
}));
vi.mock('../../src/core/session/store.js', () => ({
  listSessions: vi.fn(async () => []), deleteSession: vi.fn(async () => false),
  formatSessionEntry: vi.fn(() => ''),
}));
vi.mock('../../src/core/snapshot/index.js', () => ({
  listSnapshots: vi.fn(async () => []), restoreSnapshot: vi.fn(async () => true),
}));
vi.mock('../../src/core/mcp/manager.js', () => ({
  getMcpManager: vi.fn(() => ({ listStates: () => [] })),
}));
vi.mock('../../src/core/mcp/config.js', () => ({
  addMcpServer: vi.fn(), removeMcpServer: vi.fn(), loadMcpConfig: vi.fn(async () => ({ servers: [] })),
}));
vi.mock('../../src/core/mcp/registry.js', () => ({ searchMcpRegistry: vi.fn(async () => []) }));
vi.mock('../../src/core/index/index.js', () => ({
  buildIndex: vi.fn(async () => ({})), loadIndex: vi.fn(async () => null),
}));
vi.mock('../../src/core/swebench/export.js', () => ({ exportSwebenchPrediction: vi.fn(async () => ({})) }));
vi.mock('../../src/core/permissions/index.js', () => ({
  loadWorkspacePermissions: vi.fn(async () => null),
  setToolPermission: vi.fn(async () => ({ tools: {} })),
  resetToolPermission: vi.fn(async () => ({ tools: {} })),
}));
vi.mock('../../src/core/session/branching.js', () => ({
  loadBranchTree: vi.fn(async () => null), saveBranchTree: vi.fn(),
  getCurrentBranchId: vi.fn(() => 'main'), getBranchList: vi.fn(() => []),
  forkBranch: vi.fn(), switchToBranch: vi.fn(), deleteBranch: vi.fn(),
  visualizeBranchTree: vi.fn(() => ''), getCheckpoint: vi.fn(() => null),
}));
vi.mock('../../src/core/hooks/registry.js', () => ({ getHookRegistry: vi.fn(() => ({ list: () => [] })) }));

import { handleSlashCommand, BUILTIN_COMMANDS } from '../../src/cli/commands/index.js';
import type { CodeGruntConfig, LLMProvider } from '../../src/types.js';
import { ContextManager } from '../../src/core/context/manager.js';

const config = {
  provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-test-key-0000', maxTokens: 8192,
  temperature: 0.2, baseURL: 'https://api.deepseek.com',
} as unknown as CodeGruntConfig;

const provider: LLMProvider = {
  id: 'fake',
  // eslint-disable-next-line require-yield
  async *stream() { return; },
};

let logSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

function run(input: string, skills = [] as never[]) {
  return handleSlashCommand(input, process.cwd(), config, provider, new ContextManager('sys', 90_000), skills, 'sess-1');
}

function printed(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  writeSpy.mockRestore();
});

describe('handleSlashCommand: routing', () => {
  it('ignores input that does not start with a slash', async () => {
    expect(await run('hello')).toEqual({ type: 'not_a_command' });
  });

  it('reports unknown commands as handled', async () => {
    expect(await run('/nope')).toEqual({ type: 'handled' });
    expect(printed()).toContain('Unknown command: /nope');
  });

  it('command names are case-insensitive', async () => {
    const r = await run('/THEME dark');
    expect(r.type).toBe('config_changed');
  });

  it('/clear empties the context and returns clear', async () => {
    expect(await run('/clear')).toEqual({ type: 'clear' });
  });

  // /resume is intercepted by repl.ts before handleSlashCommand is reached, so
  // handleSlashCommand itself reports it as unknown (pinned as-is).
  const HANDLED_OUTSIDE_DISPATCH = new Set(['resume']);

  it('/resume is not handled by handleSlashCommand (repl.ts intercepts it)', async () => {
    logSpy.mockClear();
    expect(await run('/resume')).toEqual({ type: 'handled' });
    expect(printed()).toContain('Unknown command: /resume');
  });

  it('every other BUILTIN_COMMANDS entry is dispatched (none falls through to "Unknown command")', async () => {
    for (const c of BUILTIN_COMMANDS) {
      if (HANDLED_OUTSIDE_DISPATCH.has(c.name)) continue;
      logSpy.mockClear();
      const r = await run('/' + c.name);
      expect(r, `/${c.name}`).toBeDefined();
      expect(printed(), `/${c.name}`).not.toContain('Unknown command');
    }
  });

  it('aliases not listed in BUILTIN_COMMANDS still dispatch', async () => {
    logSpy.mockClear();
    expect((await run('/reasoning high')).type).toBe('config_changed');
    expect((await run('/token short')).type).toBe('handled');
    expect((await run('/apikey short')).type).toBe('handled');
    expect(printed()).not.toContain('Unknown command');
  });
});

describe('handleSlashCommand: argument-driven results', () => {
  it('/effort <level> and /reasoning <level> change reasoningEffort', async () => {
    for (const cmd of ['/effort', '/reasoning']) {
      const r = await run(`${cmd} low`);
      expect(r).toMatchObject({ type: 'config_changed', config: { reasoningEffort: 'low' } });
    }
  });

  it('/effort with no argument and a dismissed picker leaves config unchanged', async () => {
    expect(await run('/effort')).toEqual({ type: 'handled' });
  });

  it('/theme, /trust, /search-engine accept a direct value', async () => {
    expect(await run('/theme light')).toMatchObject({ type: 'config_changed', config: { theme: 'light' } });
    expect(await run('/trust plan')).toMatchObject({ type: 'config_changed', config: { trustMode: 'plan' } });
    expect(await run('/search-engine duckduckgo')).toMatchObject({ type: 'config_changed', config: { searchEngine: 'duckduckgo' } });
  });

  it('/model <id> and /model <label> switch with model_changed; unknown ids are rejected', async () => {
    expect(await run('/model deepseek-v4-flash')).toMatchObject({ type: 'model_changed', config: { model: 'deepseek-v4-flash' } });
    expect(await run('/model nonsense')).toEqual({ type: 'handled' });
    expect(printed()).toContain('Unknown model');
  });

  it('/baseurl validates, resets and sets', async () => {
    expect(await run('/baseurl')).toEqual({ type: 'handled' });
    expect(await run('/baseurl not a url')).toEqual({ type: 'handled' });
    expect(await run('/baseurl reset')).toMatchObject({ config: { baseURL: 'https://api.deepseek.com' } });
    expect(await run('/baseurl https://proxy.example/v1')).toMatchObject({ config: { baseURL: 'https://proxy.example/v1' } });
  });

  it('/config <numeric key> <value> validates ranges', async () => {
    expect(await run('/config temperature 0.8')).toMatchObject({ type: 'config_changed', config: { temperature: 0.8 } });
    expect(await run('/config temperature 9')).toEqual({ type: 'handled' });
    expect(await run('/config maxtokens 4096')).toMatchObject({ config: { maxTokens: 4096 } });
    expect(await run('/config topp 0.5')).toMatchObject({ config: { topP: 0.5 } });
  });

  it('/config with no key prints the overview, with an unknown key warns', async () => {
    expect(await run('/config')).toEqual({ type: 'handled' });
    expect(printed()).toContain('Current Configuration');
    logSpy.mockClear();
    expect(await run('/config bogus')).toEqual({ type: 'handled' });
    expect(printed()).toContain('Unknown config key');
  });

  it('/skills with no skills returns a handled/reload result without throwing', async () => {
    const r = await run('/skills');
    expect(['handled', 'skills_reload']).toContain(r.type);
  });
});
