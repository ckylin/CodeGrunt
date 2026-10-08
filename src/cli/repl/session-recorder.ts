import type { ContextManager } from '../../core/context/manager.js';
import { saveSession } from '../../core/session/store.js';
import { loadBranchTree, saveBranchTree, recordCheckpoint, getCurrentBranchId } from '../../core/session/branching.js';

/** Persists the conversation and a branch checkpoint after each successful turn. */
export class SessionRecorder {
  constructor(public id: string | undefined = undefined) {}

  async recordTurn(
    context: ContextManager,
    meta: { cwd: string; model: string; task: string },
  ): Promise<void> {
    const msgs = context.getMessages();
    const nonSysCount = msgs.filter(m => m.role !== 'system').length;
    if (nonSysCount > 0) {
      this.id = await saveSession(msgs, { id: this.id, cwd: meta.cwd, model: meta.model });
    }
    if (!this.id) return;
    // Record a checkpoint for session branching (v0.7)
    try {
      const tree = await loadBranchTree(this.id);
      const branch = tree.branches[getCurrentBranchId(tree)];
      const turnIdx = branch?.checkpoints.length ?? 0;
      await saveBranchTree(this.id, recordCheckpoint(tree, turnIdx, nonSysCount, meta.task));
    } catch { /* non-critical */ }
  }
}
