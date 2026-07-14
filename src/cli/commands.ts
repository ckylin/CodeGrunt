import chalk from 'chalk';
import type { LLMProvider, Message, CodeGruntConfig } from '../types.js';
import type { ContextManager } from '../core/context/manager.js';
import { DEEPSEEK_MODELS } from './setup.js';
import { getSessionUsage } from '../core/usage.js';
import { printBalanceAndUsage, formatDualCurrency, PRICING } from '../utils/billing.js';
import type { Skill } from './skills.js';
import { getGlobalSkillsDir, createSkill } from './skills.js';
import { validateApiKey } from '../providers/deepseek/client.js';
import { MarkdownRenderer } from '../utils/markdown.js';
import { selectFromList } from '../utils/select.js';
import { isReasonerModel } from '../config.js';
import { runInit } from './init.js';
import { saveSessionSummary, loadSessionSummary, deleteEntry, listEntries } from '../core/memory/store.js';
import { listSessions, deleteSession, formatSessionEntry } from '../core/session/store.js';
import { getHookRegistry } from '../core/hooks/registry.js';
import { listSnapshots, restoreSnapshot } from '../core/snapshot/index.js';
import { getMcpManager } from '../core/mcp/manager.js';
import { addMcpServer, removeMcpServer, loadMcpConfig } from '../core/mcp/config.js';
import type { McpServerConfig } from '../core/mcp/types.js';
import { getToolRegistry } from '../core/tools/registry.js';
import { buildIndex, loadIndex } from '../core/index/index.js';
import { exportSwebenchPrediction } from '../core/swebench/export.js';
import { loadWorkspacePermissions, setToolPermission, resetToolPermission, type PermissionAction } from '../core/permissions/index.js';


export interface CommandDescriptor {
  name: string;
  desc: string;
}

/** Canonical list of built-in slash commands (name without leading slash). */
export const BUILTIN_COMMANDS: CommandDescriptor[] = [
  { name: 'init',    desc: 'Analyze codebase and generate a CODEGRUNT.md project guide' },
  { name: 'model',   desc: 'Switch model interactively' },
  { name: 'config',  desc: 'View or change config (temperature, reasoning, etc.)' },
  { name: 'skills',  desc: 'List and manage skills' },
  { name: 'compact',  desc: 'Summarize and compress conversation history to save tokens' },
  { name: 'resume',   desc: 'Resume a previous conversation session' },
  { name: 'sessions', desc: 'List and manage saved sessions' },
  { name: 'status',   desc: 'Show current session status and cache statistics' },
  { name: 'memory',   desc: 'Show persistent memory entries and last session summary' },
  { name: 'hooks',    desc: 'List loaded hook scripts from ~/.codegrunt/hooks/' },
  { name: 'trust',    desc: 'Set trust mode: plan (read-only) / code (confirm) / auto (yes-all)' },
  { name: 'restore',  desc: 'Restore working tree to a previous snapshot (/restore lists available)' },
  { name: 'baseurl',  desc: 'Set custom DeepSeek API base URL (for mirrors / proxies)' },
  { name: 'search-engine', desc: 'Set web search engine: mojeek (default) / searxng / duckduckgo' },
  { name: 'mcp',       desc: 'Manage MCP servers: /mcp list | add | remove' },
  { name: 'index',     desc: 'Build or update the code symbol index for this project' },
  { name: 'swebench',  desc: 'Export current session diff as a SWE-bench prediction (/swebench <instance-id>)' },
  { name: 'permissions', desc: 'View or set per-tool permissions: /permissions | set <tool> <allow|deny|ask> | reset <tool>' },
  { name: 'review',  desc: 'Review session changes for logic issues' },
  { name: 'clear',   desc: 'Clear conversation context' },
  { name: 'cost',    desc: 'Show session token usage and cost' },
  { name: 'balance', desc: 'Show account balance & usage' },
  { name: 'help',    desc: 'Show full help message' },

];

export type SlashCommandResult =
  | { type: 'handled' }
  | { type: 'clear' }
  | { type: 'config_changed'; config: CodeGruntConfig }
  | { type: 'model_changed'; config: CodeGruntConfig }
  | { type: 'skills_reload' }
  | { type: 'not_a_command' };

export async function handleSlashCommand(
  input: string,
  cwd: string,
  config: CodeGruntConfig,
  provider: LLMProvider,
  context: ContextManager,
  skills: Skill[] = [],
  currentSessionId?: string,
): Promise<SlashCommandResult> {
  if (!input.startsWith('/')) return { type: 'not_a_command' };

  const [cmd, ...rest] = input.slice(1).split(' ');
  const args = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case 'help':
      printHelp(config, skills);
      return { type: 'handled' };

    case 'clear':
      context.clear();
      console.log(chalk.gray('Context cleared.'));
      return { type: 'clear' };

    case 'compact':
      await compactContext(context, config, provider, cwd);
      return { type: 'handled' };

    case 'init':
      await runInit(cwd, config, provider, args);
      return { type: 'handled' };

    case 'model':
      return await switchModel(args, config);

    case 'reasoning':
    case 'effort':
      return switchReasoningEffort(args, config);

    case 'token':
    case 'apikey':
      return await switchToken(args, config);

    case 'config':
      return await handleConfig(rest, config);

    case 'cost':
      printSessionCost(config.model);
      return { type: 'handled' };

    case 'status':
      printSessionStatus(config.model, context, currentSessionId, config);
      return { type: 'handled' };

    case 'balance':
      await printBalanceAndUsage(config.apiKey, config.baseURL, config.model);
      return { type: 'handled' };


    case 'skills':
      return await handleSkills(rest, skills);

    case 'sessions':
      await handleSessions(rest, cwd);
      return { type: 'handled' };

    case 'review':
      await reviewContext(context, config, provider);
      return { type: 'handled' };

    case 'memory':
      await handleMemoryCommand(rest, cwd);
      return { type: 'handled' };

    case 'hooks':
      printHooks();
      return { type: 'handled' };

    case 'trust':
      return switchTrustMode(args, config);

    case 'restore':
      await handleRestore(rest, cwd);
      return { type: 'handled' };

    case 'baseurl':
      return handleBaseUrl(args, config);

    case 'search-engine':
      return handleSearchEngine(args, config);

    case 'mcp':
      await handleMcp(rest);
      return { type: 'handled' };

    case 'index':
      await handleIndex(cwd);
      return { type: 'handled' };

    case 'swebench':
      await handleSwebench(rest, cwd, config);
      return { type: 'handled' };

    case 'permissions':
      await handlePermissions(rest, cwd);
      return { type: 'handled' };

    default: {
      console.log(chalk.yellow(`Unknown command: /${cmd}. Type /help for available commands.`));
      return { type: 'handled' };
    }
  }
}

// ── /help ───────────────────────────────────────────────────────────────────

function printHelp(config: CodeGruntConfig, skills: Skill[] = []): void {
  const builtinLines = BUILTIN_COMMANDS.map(
    (c) => `  ${chalk.cyan('/' + c.name)}${' '.repeat(Math.max(1, 18 - c.name.length))}${chalk.gray(c.desc)}`
  ).join('\n');

  const skillsSection = skills.length > 0
    ? `\n${chalk.bold('Skills')}\n\n` +
      skills.map((s) =>
        `  ${chalk.cyan('/' + s.name)}${' '.repeat(Math.max(1, 18 - s.name.length - 1))}${s.description ? chalk.gray(` — ${s.description}`) : chalk.gray(`(${s.source})`)}`
      ).join('\n') + '\n'
    : '';
  console.log(`
${chalk.bold('Slash Commands')}

  ${chalk.cyan('/init')}              Analyze the codebase and generate a CODEGRUNT.md project guide
  ${chalk.cyan('/model')}             Switch model interactively
  ${chalk.cyan('/model <id>')}        Switch to a specific model  (e.g. /model deepseek-v4-pro)
  ${chalk.cyan('/config')}            Show current configuration
  ${chalk.cyan('/config <key> [val]')} Set a config value interactively or directly
                        Keys: ${chalk.gray('temperature  maxtokens  topp  frequencypenalty  presencepenalty  reasoning')}
  ${chalk.cyan('/reasoning')}         Set reasoning effort for R1 models (low/medium/high)
  ${chalk.cyan('/effort <level>')}    Shortcut: /effort low | /effort medium | /effort high
  ${chalk.cyan('/cost')}              Show session token usage and cost (DeepSeek pricing)
  ${chalk.cyan('/status')}            Show session status, cache hit rate, and context size
  ${chalk.cyan('/sessions')}          List saved sessions for this directory
  ${chalk.cyan('/sessions delete <id>')} Delete a saved session
  ${chalk.cyan('/resume')}            Resume a previous session (interactive picker)
  ${chalk.cyan('/resume <id>')}       Resume a specific session by ID
  ${chalk.cyan('/balance')}           Show account balance, today's & this month's usage
  ${chalk.cyan('/skills')}            List and manage skills (create, list)
  ${chalk.cyan('/review')}            Review session changes for logic issues
  ${chalk.cyan('/help')}              Show this help message
  ${chalk.cyan('/clear')}             Clear conversation context
  ${chalk.cyan('/compact')}           Summarize and compress conversation history to save tokens
  ${chalk.cyan('/memory')}            Show persistent memory entries and last session summary
  ${chalk.cyan('/memory delete <id>')} Delete a memory entry by id
  ${chalk.cyan('/hooks')}             List loaded hook scripts
  ${chalk.cyan('/trust')}             Set trust mode: plan (read-only) / code (confirm) / auto (yes-all)
  ${chalk.cyan('/trust <mode>')}      Switch directly: /trust plan | /trust code | /trust auto
  ${chalk.cyan('/restore')}           List and restore working tree to a previous snapshot
  ${chalk.cyan('/restore <hash>')}    Restore to a specific snapshot by hash prefix
  ${chalk.cyan('/swebench <id>')}     Export current session diff as a SWE-bench prediction (JSONL)
  ${chalk.cyan('/permissions')}       Show per-tool permission overrides
  ${chalk.cyan('/permissions set <tool> <allow|deny|ask>')}  Set a tool's permission
  ${chalk.cyan('/permissions reset <tool>')}                 Remove a tool's permission override
${skillsSection}
${chalk.bold('@ References')}

  ${chalk.cyan('@<file>')}        Inject file contents into your message  (e.g. @src/index.ts)
  ${chalk.cyan('@<directory>')}   Inject directory listing                (e.g. @src/)
  ${chalk.cyan('@<url>')}         Fetch and inject webpage content        (e.g. @https://example.com)

${chalk.bold('Current')}

  temperature: ${chalk.cyan(String(config.temperature))}  max_tokens: ${chalk.cyan(String(config.maxTokens))}  top_p: ${chalk.cyan(String(config.topP ?? 1))}${config.reasoningEffort ? chalk.gray(`  reasoning: ${config.reasoningEffort}`) : ''}

${chalk.bold('Other')}

  ${chalk.cyan('exit')} / ${chalk.cyan('quit')}   Exit CodeGrunt
  ${chalk.cyan('Ctrl+C')}         Interrupt a running task
`);
}

// ── /cost ───────────────────────────────────────────────────────────────────

function printSessionCost(model: string): void {
  const usage = getSessionUsage();
  const pricing = PRICING[model] ?? PRICING['deepseek-chat'];

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.prompt;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.completion;
  const cacheSavings = (usage.cacheHitTokens / 1_000_000) * (pricing.prompt - pricing.cacheHit);
  const totalCost = inputCost + outputCost - cacheSavings;

  console.log(`
${chalk.bold('Session Usage')}
  ${chalk.gray('Model:')}        ${chalk.cyan(model)}
  ${chalk.gray('Input tokens:')}  ${usage.inputTokens.toLocaleString()}${usage.cacheHitTokens > 0 ? chalk.green(`  (${usage.cacheHitTokens.toLocaleString()} cache hits)`) : ''}
  ${chalk.gray('Output tokens:')} ${usage.outputTokens.toLocaleString()}
  ${chalk.gray('Total tokens:')}  ${(usage.inputTokens + usage.outputTokens).toLocaleString()}
${chalk.gray('─'.repeat(30))}
  ${chalk.gray('Input cost:')}   ${formatDualCurrency(inputCost)}
  ${chalk.gray('Output cost:')}  ${formatDualCurrency(outputCost)}${cacheSavings > 0 ? chalk.green(`\n  ${chalk.gray('Cache saved:')}  -${formatDualCurrency(cacheSavings)}`) : ''}
  ${chalk.bold('Session cost:')} ${formatDualCurrency(totalCost)}
`);
}

// ── /status ──────────────────────────────────────────────────────────────────

function printSessionStatus(model: string, context: ContextManager, sessionId?: string, config?: CodeGruntConfig): void {
  const usage = getSessionUsage();
  const totalInput = usage.inputTokens + usage.cacheHitTokens;
  const hitRate = totalInput > 0 ? (usage.cacheHitTokens / totalInput * 100).toFixed(1) : '0.0';
  const contextTokens = context.estimatedTokenCount();

  const sessionLine = sessionId
    ? chalk.cyan(sessionId.slice(0, 8) + '…')
    : chalk.gray('(not saved yet)');

  const trustMode = config?.trustMode ?? 'code';
  const trustLabel = trustMode === 'plan'
    ? chalk.yellow('plan (read-only)')
    : trustMode === 'auto'
      ? chalk.green('auto (yes-all)')
      : chalk.cyan('code (confirm)');

  console.log(`
${chalk.bold('Session Status')}
  ${chalk.gray('Model:')}           ${chalk.cyan(model)}
  ${chalk.gray('Session ID:')}      ${sessionLine}
  ${chalk.gray('Trust mode:')}      ${trustLabel}
  ${chalk.gray('Context size:')}    ~${contextTokens.toLocaleString()} tokens
  ${chalk.gray('Messages:')}        ${context.getMessages().filter(m => m.role !== 'system').length}
${chalk.gray('─'.repeat(30))}
${chalk.bold('Cache Statistics')}
  ${chalk.gray('Cache hit rate:')}  ${chalk.green(hitRate + '%')}  (${usage.cacheHitTokens.toLocaleString()} hits / ${totalInput.toLocaleString()} total input)
  ${chalk.gray('Cache misses:')}    ${usage.cacheMissTokens.toLocaleString()} tokens
`);
}

// ── /sessions ────────────────────────────────────────────────────────────────

async function handleSessions(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (sub === 'delete' && rest[1]) {
    const deleted = await deleteSession(rest[1]);
    if (deleted) {
      console.log(chalk.green(`✓ Deleted session ${rest[1]}`));
    } else {
      console.log(chalk.yellow(`Session "${rest[1]}" not found.`));
    }
    return;
  }

  const sessions = await listSessions(cwd);

  if (sessions.length === 0) {
    console.log(chalk.gray('\nNo saved sessions for this directory.'));
    console.log(chalk.gray('Sessions are saved automatically after each turn.\n'));
    return;
  }

  console.log(`\n${chalk.bold('Saved Sessions')} ${chalk.gray(`(${sessions.length})`)}\n`);
  for (const s of sessions) {
    console.log(`  ${chalk.cyan(s.id.slice(0, 8))}  ${formatSessionEntry(s)}`);
  }
  console.log(`\n${chalk.gray('/resume <id>  to restore a session')}`);
  console.log(chalk.gray('/sessions delete <id>  to remove a session\n'));
}

async function switchReasoningEffort(
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  const validEfforts = ['low', 'medium', 'high'] as const;

  if (arg && validEfforts.includes(arg as (typeof validEfforts)[number])) {
    const effort = arg as 'low' | 'medium' | 'high';
    console.log(
      chalk.green(`✓ Reasoning effort set to ${chalk.bold(effort)}`) +
      chalk.gray(' (only applies to reasoner/R1 models)'),
    );
    return { type: 'config_changed', config: { ...config, reasoningEffort: effort } };
  }

  // Interactive picker
  const selected = await selectFromList(
    'Select reasoning effort (only applies to R1/reasoner models)',
    [
      { value: 'low', label: 'Low', desc: 'Faster responses, less thinking' },
      { value: 'medium', label: 'Medium', desc: 'Balanced (default)' },
      { value: 'high', label: 'High', desc: 'Most thorough, slower responses' },
    ],
    config.reasoningEffort ?? 'medium',
  );

  if (!selected || selected === config.reasoningEffort) {
    console.log(chalk.gray('Reasoning effort unchanged.'));
    return { type: 'handled' };
  }

  console.log(chalk.green(`✓ Reasoning effort set to ${chalk.bold(selected)}`));
  return {
    type: 'config_changed',
    config: { ...config, reasoningEffort: selected as 'low' | 'medium' | 'high' },
  };
}

async function switchToken(
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  // If an argument is provided, use it directly
  if (arg) {
    const trimmed = arg.trim();
    if (trimmed.length < 10) {
      console.log(chalk.yellow('API key seems too short. Please check and try again.'));
      return { type: 'handled' };
    }
    process.stdout.write(chalk.gray('Validating API key…'));
    const err = await validateApiKey(trimmed, config.baseURL);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    if (err) {
      console.log(chalk.red(`✗ ${err} Key not saved.`));
      return { type: 'handled' };
    }
    console.log(chalk.green('✓ API key updated'));
    console.log(chalk.gray(`  Key: ${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`));
    return { type: 'config_changed', config: { ...config, apiKey: trimmed } };
  }

  // Interactive input (readline for direct text input)
  // try/finally ensures rl.close() is always called even if the prompt throws.
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  let newKey = '';
  try {
    console.log(chalk.gray('Enter your new DeepSeek API key (get one at https://platform.deepseek.com/api_keys):'));
    newKey = (await ask(chalk.bold('API Key: '))).trim();
  } finally {
    rl.close();
  }

  if (!newKey) {
    console.log(chalk.gray('API key unchanged.'));
    return { type: 'handled' };
  }

  if (newKey.length < 10) {
    console.log(chalk.yellow('API key seems too short. Key unchanged.'));
    return { type: 'handled' };
  }

  process.stdout.write(chalk.gray('Validating API key…'));
  const err = await validateApiKey(newKey, config.baseURL);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (err) {
    console.log(chalk.red(`✗ ${err} Key not saved.`));
    return { type: 'handled' };
  }

  console.log(chalk.green('✓ API key updated'));
  console.log(chalk.gray(`  Key: ${newKey.slice(0, 4)}...${newKey.slice(-4)}`));
  return { type: 'config_changed', config: { ...config, apiKey: newKey } };
}

// ── /config ─────────────────────────────────────────────────────────────────
// /config                        — show current config
// /config temperature [val]      — set temperature
// /config maxtokens [val]        — set max tokens
// /config topp [val]             — set top-p
// /config frequencypenalty [val] — set frequency penalty
// /config presencepenalty [val]  — set presence penalty
// /config reasoning [level]      — set reasoning effort

interface NumericConfigParam {
  key: keyof CodeGruntConfig;
  label: string;
  parse: (s: string) => number;
  validate: (n: number) => boolean;
  validationMsg: string;
  items: Array<{ value: string; label: string; desc: string }>;
  currentValue: (cfg: CodeGruntConfig) => string;
  unchanged: (cfg: CodeGruntConfig, n: number) => boolean;
  apply: (cfg: CodeGruntConfig, n: number) => CodeGruntConfig;
}

const NUMERIC_CONFIG_PARAMS: Record<string, NumericConfigParam> = {
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= 0 && n <= 2,
    validationMsg: 'Temperature must be a number between 0 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'Deterministic, consistent output' },
      { value: '0.2', label: '0.2', desc: 'Mostly deterministic (default)' },
      { value: '0.5', label: '0.5', desc: 'Balanced' },
      { value: '0.8', label: '0.8', desc: 'More creative' },
      { value: '1.0', label: '1.0', desc: 'Creative' },
      { value: '1.5', label: '1.5', desc: 'Very creative' },
      { value: '2.0', label: '2.0', desc: 'Maximum creativity' },
    ],
    currentValue: (cfg) => String(cfg.temperature),
    unchanged: (cfg, n) => n === cfg.temperature,
    apply: (cfg, n) => ({ ...cfg, temperature: n }),
  },
  maxtokens: {
    key: 'maxTokens',
    label: 'Max tokens',
    parse: (s) => parseInt(s, 10),
    validate: (n) => !isNaN(n) && n >= 256 && n <= 65536,
    validationMsg: 'Max tokens must be an integer between 256 and 65536.',
    items: [
      { value: '1024', label: '1024', desc: 'Short responses' },
      { value: '2048', label: '2048', desc: 'Medium responses' },
      { value: '4096', label: '4096', desc: 'Standard length' },
      { value: '8192', label: '8192', desc: 'Long responses (default)' },
      { value: '16384', label: '16384', desc: 'Very long responses' },
      { value: '32768', label: '32768', desc: 'Maximum length responses' },
    ],
    currentValue: (cfg) => String(cfg.maxTokens),
    unchanged: (cfg, n) => n === cfg.maxTokens,
    apply: (cfg, n) => ({ ...cfg, maxTokens: n }),
  },
  topp: {
    key: 'topP',
    label: 'Top-p',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= 0 && n <= 1,
    validationMsg: 'Top-p must be a number between 0 and 1.',
    items: [
      { value: '1', label: '1.0', desc: 'Consider all tokens (default)' },
      { value: '0.9', label: '0.9', desc: 'Top 90% probability mass' },
      { value: '0.8', label: '0.8', desc: 'Top 80%' },
      { value: '0.7', label: '0.7', desc: 'Top 70%' },
      { value: '0.5', label: '0.5', desc: 'Top 50% (more focused)' },
    ],
    currentValue: (cfg) => cfg.topP !== undefined ? String(cfg.topP) : '1',
    unchanged: (cfg, n) => cfg.topP !== undefined && n === cfg.topP,
    apply: (cfg, n) => ({ ...cfg, topP: n }),
  },
  frequencypenalty: {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= -2 && n <= 2,
    validationMsg: 'Frequency penalty must be a number between -2 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'No penalty (default)' },
      { value: '0.3', label: '0.3', desc: 'Slight repetition reduction' },
      { value: '0.6', label: '0.6', desc: 'Moderate repetition reduction' },
      { value: '1.0', label: '1.0', desc: 'Strong repetition reduction' },
      { value: '1.5', label: '1.5', desc: 'Very strong reduction' },
      { value: '2.0', label: '2.0', desc: 'Maximum reduction' },
    ],
    currentValue: (cfg) => cfg.frequencyPenalty !== undefined ? String(cfg.frequencyPenalty) : '0',
    unchanged: (cfg, n) => cfg.frequencyPenalty !== undefined && n === cfg.frequencyPenalty,
    apply: (cfg, n) => ({ ...cfg, frequencyPenalty: n }),
  },
  presencepenalty: {
    key: 'presencePenalty',
    label: 'Presence penalty',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= -2 && n <= 2,
    validationMsg: 'Presence penalty must be a number between -2 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'No penalty (default)' },
      { value: '0.3', label: '0.3', desc: 'Slight topic diversity' },
      { value: '0.6', label: '0.6', desc: 'Moderate topic diversity' },
      { value: '1.0', label: '1.0', desc: 'Strong topic diversity' },
      { value: '1.5', label: '1.5', desc: 'Very strong diversity' },
      { value: '2.0', label: '2.0', desc: 'Maximum diversity' },
    ],
    currentValue: (cfg) => cfg.presencePenalty !== undefined ? String(cfg.presencePenalty) : '0',
    unchanged: (cfg, n) => cfg.presencePenalty !== undefined && n === cfg.presencePenalty,
    apply: (cfg, n) => ({ ...cfg, presencePenalty: n }),
  },
};

async function switchNumericConfig(
  param: NumericConfigParam,
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  if (arg) {
    const val = param.parse(arg);
    if (!param.validate(val)) {
      console.log(chalk.yellow(param.validationMsg));
      return { type: 'handled' };
    }
    console.log(chalk.green(`✓ ${param.label} set to ${chalk.bold(String(val))}`));
    return { type: 'config_changed', config: param.apply(config, val) };
  }

  const selected = await selectFromList(
    `Select ${param.label.toLowerCase()}`,
    param.items,
    param.currentValue(config),
  );

  if (!selected || param.unchanged(config, param.parse(selected))) {
    console.log(chalk.gray(`${param.label} unchanged.`));
    return { type: 'handled' };
  }

  const val = param.parse(selected);
  console.log(chalk.green(`✓ ${param.label} set to ${chalk.bold(String(val))}`));
  return { type: 'config_changed', config: param.apply(config, val) };
}

async function handleConfig(
  rest: string[],
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  const sub = rest[0]?.toLowerCase();
  const val = rest.slice(1).join(' ').trim();

  const numericParam = sub ? NUMERIC_CONFIG_PARAMS[sub] ?? NUMERIC_CONFIG_PARAMS[sub.replace('_', '')] : undefined;
  if (numericParam) {
    return switchNumericConfig(numericParam, val, config);
  }

  switch (sub) {
    case 'reasoning':
    case 'effort':
      return switchReasoningEffort(val, config);

    default:
      if (!sub) {
        printConfigOverview(config);
        return { type: 'handled' };
      }
      console.log(
        chalk.yellow(`Unknown config key: ${sub}\n`) +
        chalk.gray('Available: temperature, maxtokens, topp, frequencypenalty, presencepenalty, reasoning'),
      );
      return { type: 'handled' };
  }
}

function printConfigOverview(config: CodeGruntConfig): void {
  console.log(`
${chalk.bold('Current Configuration')}

  ${chalk.gray('temperature:')}        ${chalk.cyan(String(config.temperature))}
  ${chalk.gray('max_tokens:')}         ${chalk.cyan(String(config.maxTokens))}
  ${chalk.gray('top_p:')}              ${chalk.cyan(String(config.topP ?? '1'))}
  ${chalk.gray('frequency_penalty:')}  ${chalk.cyan(String(config.frequencyPenalty ?? '0'))}
  ${chalk.gray('presence_penalty:')}   ${chalk.cyan(String(config.presencePenalty ?? '0'))}
  ${chalk.gray('reasoning_effort:')}   ${chalk.cyan(config.reasoningEffort ?? 'medium')}

${chalk.gray('Use /config <key> <value> to change a setting, e.g. /config temperature 0.8')}
`);
}

async function switchModel(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  // /model deepseek-v4-pro  — direct switch by ID
  if (arg) {
    const match = DEEPSEEK_MODELS.find((m) => m.id === arg || m.label.toLowerCase() === arg.toLowerCase());
    if (!match) {
      console.log(chalk.yellow(`Unknown model: ${arg}`));
      console.log(chalk.gray('Available: ' + DEEPSEEK_MODELS.map((m) => m.id).join(', ')));
      return { type: 'handled' };
    }
    console.log(chalk.green(`✓ Switched to ${chalk.bold(match.label)}`) + chalk.gray(` (${match.id})`));
    return { type: 'model_changed', config: { ...config, model: match.id } };
  }

  // /model — arrow-key dropdown picker
  const selected = await selectFromList(
    'Select model',
    DEEPSEEK_MODELS.map((m) => ({ value: m.id, label: m.label, desc: m.description })),
    config.model,
  );

  if (!selected || selected === config.model) {
    console.log(chalk.gray('Model unchanged.'));
    return { type: 'handled' };
  }

  const match = DEEPSEEK_MODELS.find((m) => m.id === selected)!;
  console.log(chalk.green(`✓ Switched to ${chalk.bold(match.label)}`) + chalk.gray(` (${selected})`));
  return { type: 'model_changed', config: { ...config, model: selected } };
}

// ── /clear ──────────────────────────────────────────────────────────────────
// Handled inline above via context.clear()

// ── /compact ────────────────────────────────────────────────────────────────

async function compactContext(
  context: ContextManager,
  config: CodeGruntConfig,
  provider: LLMProvider,
  cwd: string,
): Promise<void> {
  const messages = context.getMessages();
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (nonSystem.length < 4) {
    console.log(chalk.gray('Context is already short, nothing to compact.'));
    return;
  }

  const beforeMessages = messages.length;
  const beforeTokens = context.estimatedTokenCount();

  // Spinner while waiting for LLM
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${spinnerChars[spinnerIdx]} Compacting context…`));
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  const reasoner = isReasonerModel(config.model);
  const instruction = 'You are a helpful assistant. Summarize the following conversation concisely, preserving key decisions, code changes made, and any important context needed to continue the work. Output only the summary.';
  const conversationText = nonSystem
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = 'content' in m && m.content ? String(m.content) : '[tool call]';
      return `${role}: ${content}`;
    })
    .join('\n\n');

  // R1 reasoner models reject the system role — embed instruction in user message
  const summaryMessages: Message[] = reasoner
    ? [{ role: 'user', content: `[System Instructions]\n${instruction}\n\n---\n\n${conversationText}` }]
    : [
        { role: 'system', content: instruction },
        { role: 'user', content: conversationText },
      ];

  let summary = '';
  try {
    const stream = provider.stream(summaryMessages, {
      model: config.model,
      maxTokens: 1024,
      ...(reasoner ? {} : { temperature: 0.2 }),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') summary += chunk.text;
    }
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    console.log(chalk.red('Failed to compact: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (!summary.trim()) {
    console.log(chalk.yellow('Compact aborted: model returned empty summary. Context unchanged.'));
    return;
  }

  context.compact(summary.trim());
  saveSessionSummary(cwd, summary.trim()).catch(() => {});

  const afterMessages = context.getMessages().length;
  const afterTokens = context.estimatedTokenCount();
  console.log(
    chalk.green('✓ Context compacted') +
    chalk.gray(`  ${beforeMessages} → ${afterMessages} messages  (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)`),
  );
}

// ── /memory ──────────────────────────────────────────────────────────────────

async function handleMemoryCommand(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (sub === 'delete' && rest[1]) {
    const deleted = await deleteEntry(rest[1]);
    if (deleted) {
      console.log(chalk.green(`✓ Deleted memory entry ${rest[1]}`));
    } else {
      console.log(chalk.yellow(`Entry "${rest[1]}" not found.`));
    }
    return;
  }

  const [summary, entries] = await Promise.all([
    loadSessionSummary(cwd),
    listEntries(),
  ]);

  if (summary) {
    console.log(`\n${chalk.bold('Last Session Summary')}\n`);
    console.log(chalk.gray(summary));
  } else {
    console.log(chalk.gray('\nNo session summary saved yet. Run /compact to create one.'));
  }

  if (entries.length > 0) {
    console.log(`\n${chalk.bold('Memory Entries')}\n`);
    for (const e of entries) {
      console.log(`  ${chalk.cyan(`[${e.id}]`)} ${chalk.bold(e.name)} ${chalk.gray(`(${e.type})`)}`);
      console.log(`  ${chalk.gray(e.description)}`);
      const preview = e.body.length > 120 ? e.body.slice(0, 120) + '…' : e.body;
      console.log(`  ${preview}\n`);
    }
    console.log(chalk.gray('  /memory delete <id>   to remove an entry'));
  } else {
    console.log(chalk.gray('\nNo memory entries. Ask the agent to remember something using memory_write.'));
  }
  console.log('');
}

// ── /skills ─────────────────────────────────────────────────────────────────
// /skills              — list all loaded skills
// /skills create <name> — interactively create a new skill in ~/.codegrunt/skills/

async function handleSkills(
  rest: string[],
  skills: Skill[],
): Promise<SlashCommandResult> {
  const sub = rest[0]?.toLowerCase();
  const name = rest.slice(1).join(' ').trim();

  if (sub === 'create') {
    if (!name) {
      console.log(chalk.yellow('Usage: /skills create <name>'));
      console.log(chalk.gray('Example: /skills create my-skill'));
      return { type: 'handled' };
    }

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (prompt: string): Promise<string> =>
      new Promise<string>((resolve) => rl.question(prompt, resolve));

    console.log(chalk.gray(`\nCreating skill "${chalk.cyan(name)}" in ${chalk.gray(getGlobalSkillsDir())}\n`));

    // try/finally ensures rl.close() is always called even if a prompt throws.
    let desc = '';
    let content = '';
    try {
      console.log(chalk.gray('Enter a short description (optional, press Enter to skip):'));
      desc = (await ask(chalk.bold('Description: '))).trim();

      console.log(chalk.gray('\nEnter the skill content (instructions/prompt that will be sent to the model):'));
      console.log(chalk.gray('Type your content and press Enter. Multi-line is supported —'));
      console.log(chalk.gray('just keep typing and press Enter on an empty line to finish.\n'));

      const lines = [];
      while (true) {
        const line = await ask('');
        if (line === '') break;
        lines.push(line);
      }
      content = lines.join('\n').trim();
    } finally {
      rl.close();
    }
    if (!content) {
      console.log(chalk.yellow('Skill content cannot be empty. Aborted.'));
      return { type: 'handled' };
    }

    try {
      const fileName = await createSkill(name, desc || '', content);
      console.log(chalk.green(`\n✓ Skill "${name}" created: ${fileName}`));
      console.log(chalk.gray(`  Directory: ${getGlobalSkillsDir()}`));
      console.log(chalk.gray(`  Use as /${name} immediately.`));
      return { type: 'skills_reload' };
    } catch (err) {
      console.log(chalk.red(`\nFailed to create skill: ${err instanceof Error ? err.message : String(err)}`));
    }

    return { type: 'handled' };
  }

  // /skills — list all skills
  if (skills.length === 0) {
    console.log(`\n${chalk.gray('No skills loaded.')}`);
    console.log(chalk.gray(`Create one with ${chalk.cyan('/skills create <name>')}`));
    console.log(chalk.gray(`Or add .md files to ${chalk.gray(getGlobalSkillsDir())}`));
    console.log(chalk.gray(`Project skills: ${chalk.gray('.codegrunt/skills/')} (also reads .claude/skills/ for Claude Code compat)`));
    return { type: 'handled' };
  }

  console.log(`\n${chalk.bold('Skills')}\n`);

  const maxNameLen = Math.max(...skills.map((s) => s.name.length));
  for (const skill of skills) {
    const sourceLabel = skill.source === 'project' ? chalk.blue('[project]') : chalk.gray('[global]');
    const desc = skill.description ? chalk.gray(` — ${skill.description}`) : '';
    const namePadded = chalk.cyan('/' + skill.name.padEnd(maxNameLen));
    console.log(`  ${namePadded}  ${sourceLabel}${desc}`);
  }

  console.log(`\n${chalk.gray('Use /<skill-name> to run a skill')}`);
  console.log(chalk.gray(`Create: ${chalk.cyan('/skills create <name>')}`));
  console.log(chalk.gray(`Global dir: ${chalk.gray(getGlobalSkillsDir())}`));
  console.log(chalk.gray(`Project dir: ${chalk.gray('.codegrunt/skills/')}`));
  console.log(chalk.gray(`Claude-format dir: ${chalk.gray('.claude/skills/')}`));

  return { type: 'handled' };
}

// ── /search-engine ────────────────────────────────────────────────────────────

async function handleSearchEngine(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  type Engine = 'mojeek' | 'searxng' | 'duckduckgo';
  const ENGINES: Engine[] = ['mojeek', 'searxng', 'duckduckgo'];
  const DESCS: Record<Engine, string> = {
    mojeek: 'privacy-first, no API key required (default)',
    searxng: 'self-hosted metasearch — set CODEGRUNT_SEARXNG_URL',
    duckduckgo: 'DuckDuckGo instant answers (rate-limited)',
  };

  const current = config.searchEngine ?? 'mojeek';

  if (arg && ENGINES.includes(arg as Engine)) {
    const engine = arg as Engine;
    console.log(chalk.green(`✓ Search engine: ${chalk.cyan(engine)}`) + chalk.gray(`  — ${DESCS[engine]}`));
    if (engine === 'searxng' && !config.searxngUrl) {
      console.log(chalk.yellow('  Set your SearXNG URL with: CODEGRUNT_SEARXNG_URL=http://localhost:8080'));
    }
    return { type: 'config_changed', config: { ...config, searchEngine: engine } };
  }

  const selected = await selectFromList(
    'Select web search engine',
    ENGINES.map(e => ({ value: e, label: e, desc: DESCS[e] })),
    current,
  );

  if (!selected || selected === current) {
    console.log(chalk.gray('Search engine unchanged.'));
    return { type: 'handled' };
  }

  const engine = selected as Engine;
  console.log(chalk.green(`✓ Search engine: ${chalk.cyan(engine)}`));
  return { type: 'config_changed', config: { ...config, searchEngine: engine } };
}

// ── /baseurl ──────────────────────────────────────────────────────────────────
function handleBaseUrl(arg: string, config: CodeGruntConfig): SlashCommandResult {
  const DEFAULT_URL = 'https://api.deepseek.com';
  const url = arg.trim();

  if (!url) {
    console.log(`\n${chalk.bold('Current base URL:')} ${chalk.cyan(config.baseURL ?? DEFAULT_URL)}`);
    console.log(chalk.gray('Usage: /baseurl <url>  — set a custom DeepSeek API base URL'));
    console.log(chalk.gray(`       /baseurl reset  — restore to ${DEFAULT_URL}\n`));
    return { type: 'handled' };
  }

  if (url === 'reset') {
    console.log(chalk.green(`✓ Base URL reset to ${chalk.cyan(DEFAULT_URL)}`));
    return { type: 'config_changed', config: { ...config, baseURL: DEFAULT_URL } };
  }

  try {
    new URL(url); // validate
  } catch {
    console.log(chalk.yellow(`Invalid URL: ${url}`));
    return { type: 'handled' };
  }

  console.log(chalk.green(`✓ Base URL set to ${chalk.cyan(url)}`));
  console.log(chalk.gray('  Restart the session for the new URL to take effect on the provider.'));
  return { type: 'config_changed', config: { ...config, baseURL: url } };
}

// ── /trust ───────────────────────────────────────────────────────────────────

async function switchTrustMode(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  const MODES = ['plan', 'code', 'auto'] as const;
  type TrustMode = typeof MODES[number];

  const DESCRIPTIONS: Record<TrustMode, string> = {
    plan: 'read-only — all write/shell tools are blocked',
    code: 'require confirmation for each destructive operation (default)',
    auto: 'auto-approve all operations for this session',
  };

  if (arg && MODES.includes(arg as TrustMode)) {
    const mode = arg as TrustMode;
    const label = mode === 'plan' ? chalk.yellow(mode) : mode === 'auto' ? chalk.green(mode) : chalk.cyan(mode);
    console.log(chalk.green('✓ Trust mode: ') + label + chalk.gray(`  — ${DESCRIPTIONS[mode]}`));
    return { type: 'config_changed', config: { ...config, trustMode: mode } };
  }

  const selected = await selectFromList(
    'Select trust mode',
    MODES.map(m => ({ value: m, label: m, desc: DESCRIPTIONS[m] })),
    config.trustMode ?? 'code',
  );

  if (!selected || selected === (config.trustMode ?? 'code')) {
    console.log(chalk.gray('Trust mode unchanged.'));
    return { type: 'handled' };
  }

  const mode = selected as TrustMode;
  const label = mode === 'plan' ? chalk.yellow(mode) : mode === 'auto' ? chalk.green(mode) : chalk.cyan(mode);
  console.log(chalk.green('✓ Trust mode: ') + label + chalk.gray(`  — ${DESCRIPTIONS[mode]}`));
  return { type: 'config_changed', config: { ...config, trustMode: mode } };
}

// ── /hooks ───────────────────────────────────────────────────────────────────

function printHooks(): void {
  const registry = getHookRegistry();
  const hooks = registry.list();
  const hooksDir = `${process.env.HOME ?? process.env.USERPROFILE ?? '~'}/.codegrunt/hooks/`;

  if (hooks.length === 0) {
    console.log(`\n${chalk.gray('No hooks loaded.')}`);
    console.log(chalk.gray(`Add scripts to ${chalk.cyan(hooksDir)}`));
    console.log(chalk.gray('Supported events:') + ' ' + chalk.cyan('user-prompt-submit  pre-tool-use  post-tool-use  stop'));
    console.log(chalk.gray('Supported formats:') + ' ' + chalk.cyan('.sh  .bash  .js  .mjs  .cjs'));
    console.log(`\n${chalk.gray('Example: pre-tool-use.sh — block dangerous shell commands')}\n`);
    return;
  }

  console.log(`\n${chalk.bold('Loaded Hooks')} ${chalk.gray(`(${hooks.length})`)}\n`);

  const events = ['user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'stop'] as const;
  for (const event of events) {
    const matching = hooks.filter(h => h.eventType === event);
    if (matching.length === 0) continue;
    console.log(`  ${chalk.cyan(event)}`);
    for (const h of matching) {
      console.log(`    ${chalk.gray('→')} ${h.name}`);
    }
  }

  console.log(`\n${chalk.gray(`Hook directory: ${hooksDir}`)}\n`);
}

// ── /restore ─────────────────────────────────────────────────────────────────

async function handleRestore(rest: string[], cwd: string): Promise<void> {
  const snapshots = await listSnapshots(cwd);

  if (snapshots.length === 0) {
    console.log(chalk.gray('\nNo snapshots available for this directory.'));
    console.log(chalk.gray('Snapshots are created automatically after each coding turn.\n'));
    return;
  }

  const targetHash = rest[0];
  if (targetHash) {
    const entry = snapshots.find(s => s.hash.startsWith(targetHash));
    if (!entry) {
      console.log(chalk.yellow(`Snapshot "${targetHash}" not found.`));
      return;
    }
    try {
      await restoreSnapshot(cwd, entry.hash);
      console.log(chalk.green(`✓ Restored to snapshot ${chalk.cyan(entry.hash)}`));
      console.log(chalk.gray(`  ${entry.timestamp}  ${entry.message}`));
    } catch (err) {
      console.log(chalk.red(`Restore failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return;
  }

  // Interactive picker
  const choices = snapshots.map(s => ({
    label: `${chalk.cyan(s.hash)}  ${chalk.gray(s.timestamp)}  ${s.message}`,
    value: s.hash,
  }));
  const picked = await selectFromList('Restore to snapshot:', choices);
  if (!picked) return;

  const entry = snapshots.find(s => s.hash === picked)!;
  try {
    await restoreSnapshot(cwd, entry.hash);
    console.log(chalk.green(`✓ Restored to snapshot ${chalk.cyan(entry.hash)}`));
    console.log(chalk.gray(`  ${entry.timestamp}  ${entry.message}`));
    console.log(chalk.gray('  Files restored. Review changes with git diff.\n'));
  } catch (err) {
    console.log(chalk.red(`Restore failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ── /swebench ─────────────────────────────────────────────────────────────────
// /swebench <instance-id>       — export current working-tree diff as a SWE-bench prediction
// /swebench run <instance-id>   — alias for the above

async function handleSwebench(rest: string[], cwd: string, config: CodeGruntConfig): Promise<void> {
  const args = rest[0]?.toLowerCase() === 'run' ? rest.slice(1) : rest;
  const instanceId = args[0];

  if (!instanceId) {
    console.log(chalk.yellow('Usage: /swebench <instance-id>'));
    return;
  }

  try {
    const { outputPath, patchLength } = await exportSwebenchPrediction({
      cwd,
      instanceId,
      modelName: config.model,
    });
    console.log(chalk.green(`✓ Exported prediction for ${chalk.cyan(instanceId)}`));
    console.log(chalk.gray(`  ${outputPath}  (${patchLength} bytes of diff)`));
  } catch (err) {
    console.log(chalk.red(`SWE-bench export failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ── /permissions ──────────────────────────────────────────────────────────────
// /permissions                       — show current .codegrunt/permissions.json
// /permissions set <tool> <action>   — set a tool's permission (allow|deny|ask)
// /permissions reset <tool>          — remove a tool's permission override

const PERMISSION_ACTIONS = ['allow', 'deny', 'ask'] as const;

async function handlePermissions(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (sub === 'set') {
    const toolName = rest[1];
    const action = rest[2]?.toLowerCase();
    if (!toolName || !action || !PERMISSION_ACTIONS.includes(action as PermissionAction)) {
      console.log(chalk.yellow('Usage: /permissions set <tool> <allow|deny|ask>'));
      return;
    }
    const updated = await setToolPermission(cwd, toolName, action as PermissionAction);
    console.log(chalk.green(`✓ ${toolName} → ${action}`));
    console.log(chalk.gray(JSON.stringify(updated, null, 2)));
    return;
  }

  if (sub === 'reset') {
    const toolName = rest[1];
    if (!toolName) {
      console.log(chalk.yellow('Usage: /permissions reset <tool>'));
      return;
    }
    const updated = await resetToolPermission(cwd, toolName);
    console.log(chalk.green(`✓ Removed permission override for ${toolName}`));
    console.log(chalk.gray(JSON.stringify(updated, null, 2)));
    return;
  }

  // Default: show current permissions
  const permissions = await loadWorkspacePermissions(cwd);
  if (!permissions || Object.keys(permissions.tools).length === 0) {
    console.log(chalk.gray('\nNo workspace permissions configured (.codegrunt/permissions.json).'));
    console.log(chalk.gray('All tools defer to the current trust mode (/trust).\n'));
    return;
  }
  console.log(chalk.bold('\nWorkspace permissions (.codegrunt/permissions.json):\n'));
  for (const [tool, action] of Object.entries(permissions.tools)) {
    const label = action === 'deny' ? chalk.red(action) : action === 'ask' ? chalk.yellow(action) : chalk.green(action);
    console.log(`  ${chalk.cyan(tool)}: ${label}`);
  }
  console.log();
}

// ── /mcp ──────────────────────────────────────────────────────────────────────
// /mcp list                        — list configured servers and their status
// /mcp add <name> stdio <command>  — add a stdio server
// /mcp add <name> sse <url>        — add an SSE server
// /mcp remove <name>               — remove a server

async function handleMcp(rest: string[]): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (!sub || sub === 'list') {
    const config = await loadMcpConfig();
    const manager = getMcpManager();
    const states = manager.listStates();

    if (config.servers.length === 0) {
      console.log(chalk.gray('\nNo MCP servers configured.'));
      console.log(chalk.gray('Add one with: /mcp add <name> stdio <command>'));
      console.log(chalk.gray('         or: /mcp add <name> sse <url>\n'));
      return;
    }

    console.log(`\n${chalk.bold('MCP Servers')}\n`);
    for (const server of config.servers) {
      const state = states.find(s => s.config.name === server.name);
      const statusIcon = state?.status === 'connected' ? chalk.green('●') : chalk.gray('○');
      const tools = state?.toolNames.length ?? 0;
      const detail = server.transport === 'stdio' ? server.command ?? '' : server.url ?? '';
      console.log(`  ${statusIcon} ${chalk.cyan(server.name)} ${chalk.gray(`[${server.transport}]`)} ${chalk.gray(detail)}`);
      if (tools > 0) console.log(`    ${chalk.gray(`${tools} tool${tools > 1 ? 's' : ''}`)}`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const name = rest[1];
    const transport = rest[2]?.toLowerCase() as 'stdio' | 'sse' | undefined;
    const target = rest.slice(3).join(' ');

    if (!name || !transport || !target) {
      console.log(chalk.yellow('Usage: /mcp add <name> stdio <command>'));
      console.log(chalk.yellow('       /mcp add <name> sse <url>'));
      return;
    }

    if (transport !== 'stdio' && transport !== 'sse') {
      console.log(chalk.yellow('Transport must be "stdio" or "sse"'));
      return;
    }

    const serverConfig: McpServerConfig = transport === 'stdio'
      ? { name, transport: 'stdio', command: target.split(' ')[0], args: target.split(' ').slice(1) }
      : { name, transport: 'sse', url: target };

    await addMcpServer(serverConfig);

    // Connect immediately
    const manager = getMcpManager();
    try {
      const tools = await manager.connect(serverConfig);
      const registry = getToolRegistry();
      for (const tool of tools) registry.register(tool, 'mcp');
      console.log(chalk.green(`✓ MCP server "${name}" added and connected (${tools.length} tools)`));
    } catch (err) {
      console.log(chalk.yellow(`✓ MCP server "${name}" saved (connection failed: ${err instanceof Error ? err.message : String(err)})`));
      console.log(chalk.gray('  The server will be connected on next startup.'));
    }
    return;
  }

  if (sub === 'remove') {
    const name = rest[1];
    if (!name) { console.log(chalk.yellow('Usage: /mcp remove <name>')); return; }

    const manager = getMcpManager();
    manager.disconnect(name);

    const removed = await removeMcpServer(name);
    if (removed) {
      console.log(chalk.green(`✓ MCP server "${name}" removed`));
    } else {
      console.log(chalk.yellow(`Server "${name}" not found`));
    }
    return;
  }

  console.log(chalk.yellow(`Unknown /mcp subcommand: ${sub}`));
  console.log(chalk.gray('Available: list, add, remove'));
}

// ── /index ────────────────────────────────────────────────────────────────────

async function handleIndex(cwd: string): Promise<void> {
  const existing = await loadIndex(cwd);
  if (existing) {
    const age = Math.round((Date.now() - new Date(existing.builtAt).getTime()) / 60000);
    console.log(chalk.gray(`\n  Existing index: ${existing.symbols.length} symbols, ${existing.files.length} files, built ${age}m ago`));
  }

  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  let spinnerMsg = 'Building index…';
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${chalk.gray(`${spinnerChars[spinnerIdx]} ${spinnerMsg}`)}`);
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  try {
    await buildIndex(cwd, msg => { spinnerMsg = msg; });
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    const idx = await loadIndex(cwd);
    console.log(chalk.green(`✓ Code index built`) + chalk.gray(` — ${idx?.symbols.length ?? 0} symbols, ${idx?.files.length ?? 0} files\n`));
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(chalk.red(`Index build failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

async function reviewContext(
  context: ContextManager,
  config: CodeGruntConfig,
  provider: LLMProvider,
): Promise<void> {
  const messages = context.getMessages();
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (nonSystem.length < 2) {
    console.log(chalk.gray('No conversation to review yet.'));
    return;
  }

  console.log(chalk.bold('\n🔍 Reviewing session changes for logic issues…\n'));

  const reviewPrompt = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      if ('tool_calls' in m && m.tool_calls) {
        const calls = m.tool_calls.map(tc =>
          `  → ${tc.function.name}(${tc.function.arguments})`
        ).join('\n');
        return `${role}: [tool calls]\n${calls}`;
      }
      const content = 'content' in m && m.content ? String(m.content) : '';
      return `${role}: ${content}`;
    })
    .join('\n\n');

  const reviewMessages: Message[] = [
    {
      role: 'system',
      content: `You are an expert code reviewer. Analyze the following conversation log containing code changes (write_file, edit_file tool calls). Focus on:
- Logical errors or inconsistencies in the code changes
- Potential bugs, edge cases, or race conditions
- Missing error handling
- Type safety issues
- Breaking changes to existing APIs or interfaces
- Performance concerns

Provide a structured review:
1. **Critical Issues** — bugs that would cause runtime errors or data loss
2. **Logic Issues** — flaws in reasoning, incorrect assumptions, edge cases missed
3. **Style / Best Practices** — deviations from conventions, minor improvements
4. **Summary** — overall assessment

If no issues are found, clearly state that the changes look correct. Be specific — reference exact file paths and line content from the conversation.`,
    },
    {
      role: 'user',
      content: `Review this conversation session for logic issues:\n\n${reviewPrompt}`,
    },
  ];

  // Spinner animation while waiting for the first token
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${spinnerChars[spinnerIdx]} Analyzing…`));
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  let review = '';
  const md = new MarkdownRenderer();
  try {
    const stream = provider.stream(reviewMessages, {
      model: config.model,
      maxTokens: 4096,
      temperature: 0.2,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        if (!review) {
          clearInterval(spinnerInterval);
          process.stdout.write('\r' + ' '.repeat(20) + '\r');
        }
        review += chunk.text;
        const formatted = md.feed(chunk.text);
        if (formatted) process.stdout.write(formatted);
      }
    }
    // Flush any remaining markdown buffer (e.g. pending table)
    const flushOut = md.flush();
    if (flushOut) process.stdout.write(flushOut);
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(20) + '\r');
    console.log(chalk.red('\nFailed to review: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  console.log('\n');
}