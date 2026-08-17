// ── Session Branching (v0.7) ─────────────────────────────────────────────────
// Allows forking a new session from any historical turn node, visualizing the
// branch tree, and switching between branches.
//
// Architecture:
//   Each session stores a flat list of "checkpoints" — metadata entries that
//   record the message count at each turn boundary. A "branch" is a linear
//   sequence of such checkpoints; when a user forks from a historical node,
//   a new branch is created.
//
// Data model:
//   BranchTree {
//     rootBranchId: string;         // ID of the initial branch
//     branches: Map<BranchId, Branch>;
//   }
//   Branch {
//     id: string;
//     parentBranchId?: string;      // The branch this was forked from
//     forkTurnIndex?: number;       // The turn index within the parent branch where the fork occurred
//     label: string;
//     createdAt: string;            // ISO timestamp
//     checkpoints: Checkpoint[];    // One per turn in this branch
//   }
//   Checkpoint {
//     turnIndex: number;            // 0-based turn index within this branch
//     messageCount: number;         // Number of messages at this point (for restoring)
//     summary?: string;             // Short user-visible description of the turn
//   }
//
// Persistence:
//   BranchTree is stored alongside the session's message file at:
//   ~/.codegrunt/sessions/<session-id>.branches.json
//
// Usage flow:
//   1. After each agent turn, recordCheckpoint() is called automatically
//   2. User types /branch <turn-number> to fork from a historical node
//   3. User types /tree to see the branch visualization
//   4. User types /switch <branch-id> to switch to a different branch

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { getLogger } from '../observability/logger.js';

const log = getLogger('session:branching');

// ── Types ───────────────────────────────────────────────────────────────────

export interface Checkpoint {
  turnIndex: number;
  messageCount: number;
  summary: string;
  /** ISO timestamp when the checkpoint was recorded */
  timestamp: string;
}

export interface Branch {
  id: string;
  parentBranchId?: string;
  forkTurnIndex?: number;
  label: string;
  createdAt: string;
  checkpoints: Checkpoint[];
}

export interface BranchTree {
  rootBranchId: string;
  branches: Record<string, Branch>;
}

// ── Persistence ─────────────────────────────────────────────────────────────

const BRANCHES_DIR = join(homedir(), '.codegrunt', 'branches');

async function ensureDir(): Promise<void> {
  await mkdir(BRANCHES_DIR, { recursive: true });
}

function branchFilePath(sessionId: string): string {
  return join(BRANCHES_DIR, `${sessionId}.branches.json`);
}

/**
 * Load the branch tree for a given session.
 * Returns a new BranchTree if none exists yet.
 */
export async function loadBranchTree(sessionId: string): Promise<BranchTree> {
  try {
    const raw = await readFile(branchFilePath(sessionId), 'utf-8');
    return JSON.parse(raw) as BranchTree;
  } catch {
    // No existing tree — create a new one
    const branchId = randomUUID();
    const tree: BranchTree = {
      rootBranchId: branchId,
      branches: {
        [branchId]: {
          id: branchId,
          label: 'main',
          createdAt: new Date().toISOString(),
          checkpoints: [],
        },
      },
    };
    return tree;
  }
}

/**
 * Save the branch tree for a given session.
 */
export async function saveBranchTree(sessionId: string, tree: BranchTree): Promise<void> {
  await ensureDir();
  await writeFile(branchFilePath(sessionId), JSON.stringify(tree, null, 2), 'utf-8');
}

// ── Branching Operations ────────────────────────────────────────────────────

/**
 * Get the current (most recently active) branch ID.
 * Tracks state in the branch tree by storing which branch was last modified.
 */
export function getCurrentBranchId(tree: BranchTree): string {
  // The current branch is the one with the most recent checkpoint
  let currentId = tree.rootBranchId;
  let latestTs = '';

  for (const [id, branch] of Object.entries(tree.branches)) {
    const checkpoints = branch.checkpoints;
    if (checkpoints.length > 0) {
      const lastCp = checkpoints[checkpoints.length - 1];
      if (lastCp.timestamp > latestTs) {
        latestTs = lastCp.timestamp;
        currentId = id;
      }
    }
  }

  return currentId;
}

/**
 * Get all branches in order (root first, then branches in creation order).
 */
export function getBranchList(tree: BranchTree): Branch[] {
  const entries = Object.entries(tree.branches);
  // Sort: root first, then by createdAt
  entries.sort(([, a], [, b]) => {
    if (a.id === tree.rootBranchId) return -1;
    if (b.id === tree.rootBranchId) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return entries.map(([, b]) => b);
}

/**
 * Record a checkpoint after a turn completes.
 * Adds a checkpoint to the current (most recently active) branch.
 *
 * @param tree The branch tree to update
 * @param turnIndex The 0-based turn index within the current branch
 * @param messageCount Number of messages in the session at this point
 * @param summary Short description of what happened this turn
 * @returns The updated tree
 */
export function recordCheckpoint(
  tree: BranchTree,
  turnIndex: number,
  messageCount: number,
  summary: string,
): BranchTree {
  const currentId = getCurrentBranchId(tree);
  const branch = tree.branches[currentId];
  if (!branch) {
    log.warn('Current branch not found, falling back to root', { currentId });
    tree.branches[tree.rootBranchId].checkpoints.push({
      turnIndex,
      messageCount,
      summary: summary.slice(0, 120),
      timestamp: new Date().toISOString(),
    });
    return { ...tree };
  }

  branch.checkpoints.push({
    turnIndex,
    messageCount,
    summary: summary.slice(0, 120),
    timestamp: new Date().toISOString(),
  });

  return { ...tree };
}

/**
 * Fork a new branch from a historical checkpoint.
 * The new branch starts with messages up to the checkpoint point.
 *
 * @param tree The branch tree
 * @param sourceBranchId The branch to fork from
 * @param turnIndex The turn index in the source branch to fork at (0-based)
 * @param label Optional label for the new branch
 * @returns The updated tree and the new branch ID
 */
export function forkBranch(
  tree: BranchTree,
  sourceBranchId: string,
  turnIndex: number,
  label?: string,
): { tree: BranchTree; newBranchId: string } {
  const sourceBranch = tree.branches[sourceBranchId];
  if (!sourceBranch) {
    throw new Error(`Source branch "${sourceBranchId}" not found`);
  }

  // Validate turn index
  if (turnIndex < 0 || turnIndex >= sourceBranch.checkpoints.length) {
    throw new Error(
      `Invalid turn index ${turnIndex}. Branch "${sourceBranchId}" has ${sourceBranch.checkpoints.length} turns (0-${sourceBranch.checkpoints.length - 1}).`,
    );
  }

  const newBranchId = randomUUID();
  const forkCheckpoint = sourceBranch.checkpoints[turnIndex];
  const turnLabel = forkCheckpoint.summary.slice(0, 40);

  const newBranch: Branch = {
    id: newBranchId,
    parentBranchId: sourceBranchId,
    forkTurnIndex: turnIndex,
    label: label ?? `fork-${turnLabel}-${newBranchId.slice(0, 4)}`,
    createdAt: new Date().toISOString(),
    checkpoints: [],
  };

  tree.branches[newBranchId] = newBranch;

  log.info('Branch forked', {
    sourceBranchId,
    turnIndex,
    newBranchId,
    messageCount: forkCheckpoint.messageCount,
    label: newBranch.label,
  });

  return { tree, newBranchId };
}

/**
 * Delete a branch and all its descendants (child branches).
 * Cannot delete the root branch.
 *
 * @param tree The branch tree
 * @param branchId ID of the branch to delete
 * @returns Updated tree
 */
export function deleteBranch(tree: BranchTree, branchId: string): BranchTree {
  if (branchId === tree.rootBranchId) {
    throw new Error('Cannot delete the root branch');
  }

  // Find all descendant branches
  const toDelete = new Set<string>([branchId]);
  const findDescendants = (parentId: string): void => {
    for (const [id, branch] of Object.entries(tree.branches)) {
      if (branch.parentBranchId === parentId && !toDelete.has(id)) {
        toDelete.add(id);
        findDescendants(id);
      }
    }
  };
  findDescendants(branchId);

  for (const id of toDelete) {
    delete tree.branches[id];
  }

  log.info('Branch(es) deleted', { deleted: Array.from(toDelete) });
  return { ...tree };
}

/**
 * Switch to a different branch. Returns the message count at the last
 * checkpoint of that branch (for restoring messages).
 *
 * @param tree The branch tree
 * @param branchId The target branch ID
 * @returns The message count to restore to (0 if the branch has no checkpoints)
 */
export function switchToBranch(tree: BranchTree, branchId: string): number {
  const branch = tree.branches[branchId];
  if (!branch) {
    throw new Error(`Branch "${branchId}" not found`);
  }

  if (branch.checkpoints.length === 0) {
    return 0; // Empty branch — start fresh
  }

  // Return the message count of the last checkpoint
  const lastCp = branch.checkpoints[branch.checkpoints.length - 1];
  return lastCp.messageCount;
}

/**
 * Get the checkpoint at a specific turn index in a branch.
 * Returns null if the turn index is out of range.
 */
export function getCheckpoint(tree: BranchTree, branchId: string, turnIndex: number): Checkpoint | null {
  const branch = tree.branches[branchId];
  if (!branch) return null;
  if (turnIndex < 0 || turnIndex >= branch.checkpoints.length) return null;
  return branch.checkpoints[turnIndex];
}

/**
 * Build a human-readable branch tree visualization.
 *
 * @param tree The branch tree
 * @returns Array of lines (strings) for the tree display
 */
export function visualizeBranchTree(tree: BranchTree): string[] {
  const lines: string[] = [];
  const visited = new Set<string>();

  function renderBranch(branchId: string, prefix: string, isLast: boolean, depth: number): void {
    if (visited.has(branchId)) {
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${chalkRed('(circular)')} ${branchId.slice(0, 8)}`);
      return;
    }
    visited.add(branchId);

    const branch = tree.branches[branchId];
    if (!branch) return;

    const connector = isLast ? '└── ' : '├── ';
    const isRoot = branchId === tree.rootBranchId;
    const label = isRoot ? `main (${branch.checkpoints.length} turns)` : `${branch.label} (${branch.checkpoints.length} turns)`;
    const forkInfo = branch.parentBranchId
      ? ` [forked from ${branch.parentBranchId.slice(0, 8)} @ turn ${branch.forkTurnIndex}]`
      : '';

    lines.push(`${prefix}${connector}${label}${forkInfo}`);

    // Render children
    const children = Object.entries(tree.branches)
      .filter(([, b]) => b.parentBranchId === branchId)
      .map(([id]) => id);

    for (let i = 0; i < children.length; i++) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      renderBranch(children[i], childPrefix, i === children.length - 1, depth + 1);
    }
  }

  // Start with root
  lines.push('Branch Tree:');
  visited.clear();
  const root = tree.branches[tree.rootBranchId];
  if (root) {
    lines.push(`└── main (${root.checkpoints.length} turns)`);
    const children = Object.entries(tree.branches)
      .filter(([, b]) => b.parentBranchId === tree.rootBranchId)
      .map(([id]) => id);

    for (let i = 0; i < children.length; i++) {
      const childPrefix = '    ';
      renderBranch(children[i], childPrefix, i === children.length - 1, 1);
    }
  }

  // Add current branch marker
  const currentId = getCurrentBranchId(tree);
  lines.push('');
  lines.push(`Current: ${currentId.slice(0, 8)}`);

  // List branches with details
  lines.push('');
  lines.push('Branches:');
  const allBranches = getBranchList(tree);
  for (const b of allBranches) {
    const isCurrent = b.id === currentId;
    const marker = isCurrent ? '→ ' : '  ';
    const checkpoints = b.checkpoints.length;
    const lastCp = b.checkpoints.length > 0
      ? ` — last: "${b.checkpoints[b.checkpoints.length - 1].summary.slice(0, 50)}"`
      : ' (empty)';
    const forkFrom = b.parentBranchId
      ? ` (from ${b.parentBranchId.slice(0, 8)} @ turn ${b.forkTurnIndex})`
      : '';
    lines.push(`${marker}${b.id.slice(0, 8)}  ${b.label}${forkFrom} — ${checkpoints} turns${lastCp}`);
  }

  return lines;
}

/** ANSI red — lightweight replacement for chalk in a data-only module */
function chalkRed(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
