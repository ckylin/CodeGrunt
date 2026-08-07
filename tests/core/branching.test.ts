import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {
  loadBranchTree,
  saveBranchTree,
  getCurrentBranchId,
  getBranchList,
  recordCheckpoint,
  forkBranch,
  deleteBranch,
  switchToBranch,
  getCheckpoint,
  visualizeBranchTree,
  type BranchTree,
} from '../../src/core/session/branching.js';

const BRANCHES_DIR = join(homedir(), '.codegrunt', 'branches');

describe('session branching', () => {
  let sessionId: string;

  beforeEach(() => {
    sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    await rm(join(BRANCHES_DIR, `${sessionId}.branches.json`), { force: true });
  });

  describe('loadBranchTree', () => {
    it('creates a fresh tree with a single root "main" branch when none exists', async () => {
      const tree = await loadBranchTree(sessionId);
      expect(Object.keys(tree.branches)).toHaveLength(1);
      const root = tree.branches[tree.rootBranchId];
      expect(root.label).toBe('main');
      expect(root.checkpoints).toEqual([]);
    });
  });

  describe('saveBranchTree / loadBranchTree round-trip', () => {
    it('persists and reloads the same tree structure', async () => {
      const tree = await loadBranchTree(sessionId);
      const updated = recordCheckpoint(tree, 0, 2, 'first turn');
      await saveBranchTree(sessionId, updated);

      const reloaded = await loadBranchTree(sessionId);
      expect(reloaded.rootBranchId).toBe(updated.rootBranchId);
      expect(reloaded.branches[reloaded.rootBranchId].checkpoints).toHaveLength(1);
      expect(reloaded.branches[reloaded.rootBranchId].checkpoints[0].summary).toBe('first turn');
    });
  });

  describe('recordCheckpoint', () => {
    it('appends a checkpoint to the current (root) branch', () => {
      const tree = makeFreshTree();
      const updated = recordCheckpoint(tree, 0, 4, 'did something');
      const root = updated.branches[updated.rootBranchId];
      expect(root.checkpoints).toHaveLength(1);
      expect(root.checkpoints[0]).toMatchObject({ turnIndex: 0, messageCount: 4, summary: 'did something' });
    });

    it('truncates summaries longer than 120 characters', () => {
      const tree = makeFreshTree();
      const longSummary = 'x'.repeat(200);
      const updated = recordCheckpoint(tree, 0, 1, longSummary);
      const root = updated.branches[updated.rootBranchId];
      expect(root.checkpoints[0].summary).toHaveLength(120);
    });

    it('records multiple checkpoints in call order on the same branch', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'turn 0');
      tree = recordCheckpoint(tree, 1, 5, 'turn 1');
      const root = tree.branches[tree.rootBranchId];
      expect(root.checkpoints.map(c => c.summary)).toEqual(['turn 0', 'turn 1']);
    });
  });

  describe('forkBranch', () => {
    it('creates a new branch pointing back at the source branch and turn index', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'turn 0');
      tree = recordCheckpoint(tree, 1, 4, 'turn 1');

      const { tree: forked, newBranchId } = forkBranch(tree, tree.rootBranchId, 0, 'experiment');
      const branch = forked.branches[newBranchId];
      expect(branch.parentBranchId).toBe(tree.rootBranchId);
      expect(branch.forkTurnIndex).toBe(0);
      expect(branch.label).toBe('experiment');
      expect(branch.checkpoints).toEqual([]);
    });

    it('generates a default label from the checkpoint summary when none is given', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'fix the login bug');
      const { tree: forked, newBranchId } = forkBranch(tree, tree.rootBranchId, 0);
      expect(forked.branches[newBranchId].label).toContain('fix the login bug');
    });

    it('throws when the source branch does not exist', () => {
      const tree = makeFreshTree();
      expect(() => forkBranch(tree, 'nonexistent', 0)).toThrow(/not found/);
    });

    it('throws when the turn index is out of range', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'only turn');
      expect(() => forkBranch(tree, tree.rootBranchId, 5)).toThrow(/Invalid turn index/);
      expect(() => forkBranch(tree, tree.rootBranchId, -1)).toThrow(/Invalid turn index/);
    });
  });

  describe('switchToBranch', () => {
    it('returns 0 for a branch with no checkpoints', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'turn 0');
      const { tree: forked, newBranchId } = forkBranch(tree, tree.rootBranchId, 0);
      expect(switchToBranch(forked, newBranchId)).toBe(0);
    });

    it('returns the message count of the last checkpoint', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'turn 0');
      tree = recordCheckpoint(tree, 1, 6, 'turn 1');
      expect(switchToBranch(tree, tree.rootBranchId)).toBe(6);
    });

    it('throws for a nonexistent branch id', () => {
      const tree = makeFreshTree();
      expect(() => switchToBranch(tree, 'nope')).toThrow(/not found/);
    });
  });

  describe('getCurrentBranchId', () => {
    it('returns the root branch when there is only one branch', () => {
      const tree = makeFreshTree();
      expect(getCurrentBranchId(tree)).toBe(tree.rootBranchId);
    });

    it('returns the branch with the most recent checkpoint timestamp', async () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'root turn');
      const { tree: forked, newBranchId } = forkBranch(tree, tree.rootBranchId, 0, 'child');
      // Small delay so the child checkpoint has a strictly later ISO timestamp.
      await new Promise(r => setTimeout(r, 5));
      const withChildCheckpoint = recordCheckpointOnBranch(forked, newBranchId, 0, 3, 'child turn');
      expect(getCurrentBranchId(withChildCheckpoint)).toBe(newBranchId);
    });
  });

  describe('getBranchList', () => {
    it('lists the root branch first, followed by others in creation order', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'root turn');
      const { tree: forked, newBranchId } = forkBranch(tree, tree.rootBranchId, 0, 'child');
      const list = getBranchList(forked);
      expect(list[0].id).toBe(tree.rootBranchId);
      expect(list[1].id).toBe(newBranchId);
    });
  });

  describe('deleteBranch', () => {
    it('removes a branch and all of its descendants', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'root turn');
      const { tree: t1, newBranchId: child } = forkBranch(tree, tree.rootBranchId, 0, 'child');
      const t1WithCp = recordCheckpointOnBranch(t1, child, 0, 3, 'child turn');
      const { tree: t2, newBranchId: grandchild } = forkBranch(t1WithCp, child, 0, 'grandchild');

      const result = deleteBranch(t2, child);
      expect(result.branches[child]).toBeUndefined();
      expect(result.branches[grandchild]).toBeUndefined();
      expect(result.branches[tree.rootBranchId]).toBeDefined();
    });

    it('refuses to delete the root branch', () => {
      const tree = makeFreshTree();
      expect(() => deleteBranch(tree, tree.rootBranchId)).toThrow(/Cannot delete the root branch/);
    });
  });

  describe('getCheckpoint', () => {
    it('returns the checkpoint at a valid turn index', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'turn 0');
      const cp = getCheckpoint(tree, tree.rootBranchId, 0);
      expect(cp?.summary).toBe('turn 0');
    });

    it('returns null for an out-of-range turn index', () => {
      const tree = makeFreshTree();
      expect(getCheckpoint(tree, tree.rootBranchId, 0)).toBeNull();
    });

    it('returns null for a nonexistent branch', () => {
      const tree = makeFreshTree();
      expect(getCheckpoint(tree, 'nope', 0)).toBeNull();
    });
  });

  describe('visualizeBranchTree', () => {
    it('renders the main branch and forked children with turn counts', () => {
      let tree = makeFreshTree();
      tree = recordCheckpoint(tree, 0, 2, 'root turn');
      const { tree: forked } = forkBranch(tree, tree.rootBranchId, 0, 'my-experiment');

      const lines = visualizeBranchTree(forked).join('\n');
      expect(lines).toContain('main (1 turns)');
      expect(lines).toContain('my-experiment');
      expect(lines).toContain('Current:');
      expect(lines).toContain('Branches:');
    });
  });
});

function makeFreshTree(): BranchTree {
  const rootId = 'root-' + Math.random().toString(36).slice(2);
  return {
    rootBranchId: rootId,
    branches: {
      [rootId]: {
        id: rootId,
        label: 'main',
        createdAt: new Date().toISOString(),
        checkpoints: [],
      },
    },
  };
}

/** Test helper: record a checkpoint directly on a specific branch (bypassing "current" resolution). */
function recordCheckpointOnBranch(tree: BranchTree, branchId: string, turnIndex: number, messageCount: number, summary: string): BranchTree {
  const branch = tree.branches[branchId];
  branch.checkpoints.push({
    turnIndex,
    messageCount,
    summary: summary.slice(0, 120),
    timestamp: new Date().toISOString(),
  });
  return { ...tree };
}
