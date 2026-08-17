// ── Session Branching Commands (v0.7) ─────────────────────────────────────────
// Handler functions for /branch, /tree, /switch, /subagent-cache slash commands.

import chalk from 'chalk';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ContextManager } from '../core/context/manager.js';
import {
  loadBranchTree, saveBranchTree, getCurrentBranchId,
  forkBranch, switchToBranch, visualizeBranchTree, getCheckpoint,
} from '../core/session/branching.js';
import { getSubagentCacheStats, clearSubagentCache } from '../core/agent/subagent.js';
import { getLogger } from '../core/observability/logger.js';

const log = getLogger('cli:branch');
const BRANCHES_DIR = join(homedir(), '.codegrunt', 'branches');

/**
 * /branch <turn-number> [label]
 * Fork a new branch from a historical turn in the current session.
 */
export async function handleBranch(
  args: string,
  _cwd: string,
  context: ContextManager,
  currentSessionId?: string,
): Promise<void> {
  if (!currentSessionId) {
    console.log(chalk.yellow('No active session. Start a conversation first, then use /branch.'));
    return;
  }

  const parts = args.split(/\s+/);
  const turnNum = parseInt(parts[0], 10);
  const label = parts.slice(1).join(' ') || undefined;

  if (isNaN(turnNum) || turnNum < 0) {
    console.log(chalk.yellow('Usage: /branch <turn-number> [label]\nExample: /branch 2 experiment-auth'));
    return;
  }

  try {
    const tree = await loadBranchTree(currentSessionId);
    const currentId = getCurrentBranchId(tree);
    const branch = tree.branches[currentId];
    if (!branch) {
      console.log(chalk.yellow('Current branch not found.'));
      return;
    }

    if (turnNum >= branch.checkpoints.length) {
      console.log(chalk.yellow(
        `Invalid turn number ${turnNum}. Current branch has ${branch.checkpoints.length} turns (0-${branch.checkpoints.length - 1}).`,
      ));
      return;
    }

    const { tree: updatedTree, newBranchId } = forkBranch(tree, currentId, turnNum, label);
    await saveBranchTree(currentSessionId, updatedTree);

    const checkpoint = getCheckpoint(updatedTree, newBranchId, 0);
    const checkpointMsgCount = checkpoint?.messageCount ?? 0;

    // Restore messages to the checkpoint point
    const allMessages = context.getMessages();
    const systemMessages = allMessages.filter(m => m.role === 'system');
    const nonSystemMessages = allMessages.filter(m => m.role !== 'system');
    const restoredMessages = [...systemMessages, ...nonSystemMessages.slice(0, checkpointMsgCount)];
    context.setMessages(restoredMessages);

    console.log(chalk.green(`✓ Branch created: ${chalk.cyan(updatedTree.branches[newBranchId].label)}`));
    console.log(chalk.gray(`  Forked from ${chalk.cyan(currentId.slice(0, 8))} @ turn ${turnNum}`));
    console.log(chalk.gray(`  Messages restored to checkpoint (${checkpointMsgCount} non-system msgs)`));
    console.log(chalk.gray('  Use /tree to see all branches, /switch <branch-id> to switch'));
  } catch (err) {
    console.log(chalk.red(`Branch failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * /tree
 * Visualize the session branch tree.
 */
export async function handleTree(
  _cwd: string,
  currentSessionId?: string,
): Promise<void> {
  if (!currentSessionId) {
    console.log(chalk.yellow('No active session. Start a conversation first.'));
    return;
  }

  try {
    const tree = await loadBranchTree(currentSessionId);
    const lines = visualizeBranchTree(tree);
    for (const line of lines) {
      console.log(line);
    }
  } catch (err) {
    console.log(chalk.red(`Failed to load branch tree: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * /switch <branch-id>
 * Switch to a different branch.
 */
export async function handleSwitchBranch(
  branchId: string,
  _cwd: string,
  context: ContextManager,
): Promise<void> {
  if (!branchId) {
    console.log(chalk.yellow('Usage: /switch <branch-id>\nUse /tree to list available branches.'));
    return;
  }

  const id = branchId.trim();

  try {
    // Find the branch file by scanning the branches directory
    let sessionFile: string | undefined;
    let sessionId: string | undefined;

    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(BRANCHES_DIR);
      for (const f of files) {
        try {
          const raw = readFileSync(join(BRANCHES_DIR, f), 'utf-8');
          if (raw.includes(id)) {
            sessionFile = f;
            break;
          }
        } catch { continue; }
      }
    } catch {
      console.log(chalk.yellow(`No branch data found. Start a conversation first.`));
      return;
    }

    if (!sessionFile) {
      console.log(chalk.yellow(`Branch "${id}" not found. Use /tree to list available branches.`));
      return;
    }

    sessionId = sessionFile.replace('.branches.json', '');
    const tree = await loadBranchTree(sessionId);
    const msgCount = switchToBranch(tree, id);

    // Restore messages
    const allMessages = context.getMessages();
    const systemMessages = allMessages.filter(m => m.role === 'system');
    const nonSystemMessages = allMessages.filter(m => m.role !== 'system');
    const restoredMessages = [...systemMessages, ...nonSystemMessages.slice(0, msgCount)];
    context.setMessages(restoredMessages);

    const branch = tree.branches[id];
    const branchLabel = branch?.label ?? id.slice(0, 8);

    console.log(chalk.green(`✓ Switched to branch: ${chalk.cyan(branchLabel)}`));
    console.log(chalk.gray(`  Messages restored to checkpoint (${msgCount} non-system msgs)`));
    console.log(chalk.gray('  Use /tree to see all branches'));
  } catch (err) {
    console.log(chalk.red(`Switch failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * /subagent-cache [clear]
 * Show or clear the sub-agent result cache.
 */
export function handleSubagentCache(args: string): void {
  const sub = args.trim().toLowerCase();

  if (sub === 'clear') {
    clearSubagentCache();
    console.log(chalk.green('✓ Sub-agent cache cleared'));
    return;
  }

  const stats = getSubagentCacheStats();
  console.log(chalk.bold('\nSub-agent Cache'));
  console.log(`  ${chalk.gray('Entries:')} ${stats.size} / ${stats.maxSize}`);
  console.log(`  ${chalk.gray('TTL:')}    ${stats.ttlMs / 1000}s`);
  console.log(chalk.gray('  /subagent-cache clear  to clear all cached results\n'));
}
