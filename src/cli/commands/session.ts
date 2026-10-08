import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import type { ContextManager } from '../../core/context/manager.js';
import { getSessionUsage } from '../../core/usage.js';
import { listSessions, deleteSession, formatSessionEntry } from '../../core/session/store.js';
import { printPaged } from '../../utils/pager.js';
import { handleBranch, handleTree, handleSwitchBranch, handleSubagentCache } from '../branch-commands.js';
import type { SlashCommand } from './types.js';

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

  const lines = [
    '',
    `${chalk.bold('Saved Sessions')} ${chalk.gray(`(${sessions.length})`)}`,
    '',
    ...sessions.map((s) => `  ${chalk.cyan(s.id.slice(0, 8))}  ${formatSessionEntry(s)}`),
    '',
    chalk.gray('/resume <id>  to restore a session'),
    chalk.gray('/sessions delete <id>  to remove a session'),
    '',
  ];
  await printPaged(lines.join('\n'));
}

export const sessionCommands: SlashCommand[] = [
  {
    name: 'clear',
    desc: 'Clear conversation context',
    run({ context }) {
      context.clear();
      console.log(chalk.gray('Context cleared.'));
      return { type: 'clear' };
    },
  },
  {
    name: 'resume',
    desc: 'Resume a previous conversation session',
    // No run(): repl.ts intercepts /resume before dispatch.
  },
  {
    name: 'sessions',
    desc: 'List and manage saved sessions',
    async run({ rest, cwd }) {
      await handleSessions(rest, cwd);
      return { type: 'handled' };
    },
  },
  {
    name: 'status',
    desc: 'Show current session status and cache statistics',
    run({ config, context, currentSessionId }) {
      printSessionStatus(config.model, context, currentSessionId, config);
      return { type: 'handled' };
    },
  },
  {
    name: 'branch',
    desc: 'Create a session branch from a historical turn: /branch <turn-number> [label]',
    async run({ args, cwd, context, currentSessionId }) {
      await handleBranch(args, cwd, context, currentSessionId);
      return { type: 'handled' };
    },
  },
  {
    name: 'tree',
    desc: 'Visualize the session branch tree',
    async run({ cwd, currentSessionId }) {
      await handleTree(cwd, currentSessionId);
      return { type: 'handled' };
    },
  },
  {
    name: 'switch',
    desc: 'Switch to a different branch: /switch <branch-id>',
    async run({ args, cwd, context }) {
      await handleSwitchBranch(args, cwd, context);
      return { type: 'handled' };
    },
  },
  {
    name: 'subagent-cache',
    desc: 'Show or clear the sub-agent result cache',
    run({ args }) {
      handleSubagentCache(args);
      return { type: 'handled' };
    },
  },
];
