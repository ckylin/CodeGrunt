import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeGruntConfig, LLMProvider } from '../../src/types.js';
import { ContextManager } from '../../src/core/context/manager.js';
import { CommandRegistry, dispatchSlashCommand, commandRegistry } from '../../src/cli/commands/registry.js';
import { BUILTIN_COMMANDS, BUILTIN_COMMAND_ORDER } from '../../src/cli/commands/index.js';
import type { SlashCommand } from '../../src/cli/commands/types.js';

const config = { model: 'deepseek-v4-pro', temperature: 0.2, maxTokens: 8192 } as unknown as CodeGruntConfig;
const provider: LLMProvider = {
  id: 'fake',
  // eslint-disable-next-line require-yield
  async *stream() { return; },
};

function cmd(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return { name, desc: `${name} desc`, run: () => ({ type: 'handled' }), ...extra };
}

describe('CommandRegistry', () => {
  it('looks commands up by name and alias, case-insensitively', () => {
    const registry = new CommandRegistry();
    const effort = cmd('effort', { aliases: ['reasoning'] });
    registry.register(effort);
    for (const key of ['effort', 'EFFORT', 'reasoning', 'Reasoning']) {
      expect(registry.get(key), key).toBe(effort);
    }
    expect(registry.get('nope')).toBeUndefined();
  });

  // Decision: a duplicate name or alias is a programming error, so register()
  // throws (and registers nothing) instead of silently shadowing a command.
  it('rejects a duplicate name or alias and leaves the registry untouched', () => {
    const registry = new CommandRegistry();
    registry.register(cmd('a', { aliases: ['x'] }));
    expect(() => registry.register(cmd('A'))).toThrow(/Duplicate slash command: \/a/);
    expect(() => registry.register(cmd('b', { aliases: ['X'] }))).toThrow(/Duplicate slash command: \/x/);
    expect(() => registry.register(cmd('c', { aliases: ['c'] }))).toThrow(/Duplicate slash command: \/c/);
    expect(registry.list().map((c) => c.name)).toEqual(['a']);
    expect(registry.get('b')).toBeUndefined();
  });
});

describe('dispatchSlashCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  const run = (registry: CommandRegistry, input: string) =>
    dispatchSlashCommand(registry, input, '/tmp', config, provider, new ContextManager('sys', 90_000));

  it('passes the words after the command as rest and the trimmed join as args', async () => {
    const registry = new CommandRegistry();
    const seen: Array<{ rest: string[]; args: string }> = [];
    registry.register(cmd('echo', { run: ({ rest, args }) => { seen.push({ rest, args }); return { type: 'handled' }; } }));
    await run(registry, '/echo  a b ');
    expect(seen).toEqual([{ rest: ['', 'a', 'b', ''], args: 'a b' }]);
  });

  it.each([
    ['plain text', 'hello', 'not_a_command'],
    ['an unknown command', '/nope', 'handled'],
    ['a listed command without run()', '/listed-only', 'handled'],
  ])('%s -> %s', async (_label, input, type) => {
    const registry = new CommandRegistry();
    registry.register({ name: 'listed-only', desc: 'no handler' });
    expect((await run(registry, input)).type).toBe(type);
  });

  it('reports unknown commands with the name as typed', async () => {
    await run(new CommandRegistry(), '/NoPe');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Unknown command: /NoPe. Type /help for available commands.');
  });

  it('returns whatever the command returns', async () => {
    const registry = new CommandRegistry();
    registry.register(cmd('clear', { run: () => ({ type: 'clear' }) }));
    expect(await run(registry, '/CLEAR')).toEqual({ type: 'clear' });
  });
});

describe('built-in commands', () => {
  it('BUILTIN_COMMANDS keeps the original order and descriptions', () => {
    expect(BUILTIN_COMMANDS).toEqual([
      { name: 'init', desc: 'Analyze codebase and generate a CODEGRUNT.md project guide' },
      { name: 'model', desc: 'Switch model interactively' },
      { name: 'config', desc: 'View or change config (temperature, reasoning, etc.)' },
      { name: 'skills', desc: 'List and manage skills' },
      { name: 'compact', desc: 'Summarize and compress conversation history to save tokens' },
      { name: 'resume', desc: 'Resume a previous conversation session' },
      { name: 'sessions', desc: 'List and manage saved sessions' },
      { name: 'status', desc: 'Show current session status and cache statistics' },
      { name: 'memory', desc: 'Show persistent memory entries and last session summary' },
      { name: 'hooks', desc: 'List loaded hook scripts from ~/.codegrunt/hooks/' },
      { name: 'trust', desc: 'Set trust mode: plan (read-only) / code (confirm) / auto (yes-all)' },
      { name: 'restore', desc: 'Restore working tree to a previous snapshot (/restore lists available)' },
      { name: 'baseurl', desc: 'Set custom DeepSeek API base URL (for mirrors / proxies)' },
      { name: 'search-engine', desc: 'Set web search engine: mojeek (default) / searxng / duckduckgo' },
      { name: 'mcp', desc: 'Manage MCP servers: /mcp list | add | remove | search' },
      { name: 'index', desc: 'Build or update the code symbol index for this project (--semantic for vector search)' },
      { name: 'swebench', desc: 'Export current session diff as a SWE-bench prediction (/swebench <instance-id>)' },
      { name: 'permissions', desc: 'View or set per-tool permissions: /permissions | set <tool> <allow|deny|ask> | reset <tool>' },
      { name: 'review', desc: 'Review session changes for logic issues' },
      { name: 'clear', desc: 'Clear conversation context' },
      { name: 'cost', desc: 'Show session token usage and cost' },
      { name: 'cache', desc: 'Show detailed DeepSeek prefix cache performance statistics' },
      { name: 'cost-report', desc: 'Show aggregated cost report with per-model breakdown' },
      { name: 'balance', desc: 'Show account balance & usage' },
      { name: 'help', desc: 'Show full help message' },
      { name: 'branch', desc: 'Create a session branch from a historical turn: /branch <turn-number> [label]' },
      { name: 'tree', desc: 'Visualize the session branch tree' },
      { name: 'switch', desc: 'Switch to a different branch: /switch <branch-id>' },
      { name: 'subagent-cache', desc: 'Show or clear the sub-agent result cache' },
      { name: 'effort', desc: 'Set reasoning effort: low (flash) / medium (auto) / high (pro+thinking)' },
      { name: 'theme', desc: 'Set TUI color theme: dark (default) / light' },
    ]);
  });

  it('the display-order list and the registry cannot drift apart', () => {
    const visible = commandRegistry.list().filter((c) => !c.hidden).map((c) => c.name);
    expect([...visible].sort()).toEqual([...BUILTIN_COMMAND_ORDER].sort());
    expect(new Set(BUILTIN_COMMAND_ORDER).size).toBe(BUILTIN_COMMAND_ORDER.length);
  });

  it('aliases and hidden commands dispatch but are not listed', () => {
    const listed = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    for (const name of ['reasoning', 'token', 'apikey']) {
      expect(commandRegistry.get(name), name).toBeDefined();
      expect(listed.has(name), name).toBe(false);
    }
    expect(commandRegistry.get('reasoning')).toBe(commandRegistry.get('effort'));
    expect(commandRegistry.get('apikey')).toBe(commandRegistry.get('token'));
  });

  it('/resume is listed but has no handler (the REPL intercepts it)', () => {
    expect(commandRegistry.get('resume')).toBeDefined();
    expect(commandRegistry.get('resume')?.run).toBeUndefined();
  });
});
