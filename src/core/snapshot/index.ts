// ── Side-git Snapshot ─────────────────────────────────────────────────────
// Creates lightweight git snapshots of the working tree after each agent turn,
// stored in .codegrunt/git (a separate git-dir that doesn't touch .git).
//
// Why separate git-dir:
//   git --git-dir=.codegrunt/git --work-tree=. <cmd>
//   This lets us commit snapshots without polluting the user's real git history,
//   branch list, or stash. The user's .git is never touched.
//
// Snapshot format:
//   Each turn creates a commit on a single branch "snapshots" with message:
//   "snapshot: <ISO timestamp> — <short task description>"
//
// Usage:
//   await createSnapshot(cwd, taskSummary)   — call after each agent turn
//   listSnapshots(cwd)                       — returns list for /restore picker
//   restoreSnapshot(cwd, commitHash)         — checkout files from a snapshot
//
// Caveats:
//   - Requires git to be installed and in PATH
//   - Only tracks files that are tracked by the *user's* git repo
//     (respects .gitignore, skips node_modules etc.)
//   - If the cwd is not a git repo, snapshots are silently skipped

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../observability/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('snapshot');

const SNAPSHOT_BRANCH = 'snapshots';

function gitDir(cwd: string): string {
  return join(cwd, '.codegrunt', 'git');
}

/** Run a git command against the side git-dir */
async function sideGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    `--git-dir=${gitDir(cwd)}`,
    `--work-tree=${cwd}`,
    ...args,
  ], { cwd });
  return stdout.trim();
}

/** Check if the cwd is inside a real git repo (user's .git) */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Initialize the side git-dir if it doesn't exist yet */
async function ensureInitialized(cwd: string): Promise<void> {
  const dir = gitDir(cwd);
  if (!existsSync(dir)) {
    await execFileAsync('git', ['init', '--bare', dir], { cwd });
    // Create an initial empty commit so the branch exists
    await sideGit(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${SNAPSHOT_BRANCH}`]);
  }
}

export interface SnapshotEntry {
  hash: string;
  timestamp: string;
  message: string;
}

/**
 * Create a snapshot of the current working tree state.
 * Silently returns if cwd is not a git repo or git is unavailable.
 */
export async function createSnapshot(cwd: string, taskSummary: string): Promise<string | null> {
  try {
    if (!(await isGitRepo(cwd))) return null;
    await ensureInitialized(cwd);

    // Stage all tracked files (respects .gitignore via user's index)
    await sideGit(cwd, ['add', '-A']);

    // Check if there's anything to commit
    try {
      await sideGit(cwd, ['diff', '--cached', '--quiet']);
      // Exit 0 means nothing staged — no changes since last snapshot
      return null;
    } catch {
      // Exit 1 means there ARE staged changes — proceed
    }

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const summary = taskSummary.slice(0, 80).replace(/\n/g, ' ');
    const message = `snapshot: ${timestamp} — ${summary}`;

    // Commit without a user identity (uses side git config)
    const hash = await sideGit(cwd, [
      '-c', 'user.name=codegrunt',
      '-c', 'user.email=codegrunt@local',
      'commit', '-m', message,
    ]);

    const shortHash = await sideGit(cwd, ['rev-parse', '--short', 'HEAD']);
    log.info('Snapshot created', { hash: shortHash, summary });
    return shortHash;
  } catch (err) {
    // Never crash the agent due to snapshot failure
    log.warn('Snapshot failed (ignored)', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * List all snapshots for a given cwd, newest first.
 */
export async function listSnapshots(cwd: string): Promise<SnapshotEntry[]> {
  try {
    if (!existsSync(gitDir(cwd))) return [];
    const out = await sideGit(cwd, [
      'log', SNAPSHOT_BRANCH,
      '--format=%H|%ci|%s',
      '--max-count=50',
    ]);
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
      const [hash, timestamp, ...rest] = line.split('|');
      return { hash: hash.slice(0, 8), timestamp: timestamp.trim(), message: rest.join('|') };
    });
  } catch {
    return [];
  }
}

/**
 * Restore the working tree to a snapshot state.
 * Only restores files — does not touch the user's git history.
 */
export async function restoreSnapshot(cwd: string, hash: string): Promise<void> {
  await sideGit(cwd, ['checkout', hash, '--', '.']);
}
