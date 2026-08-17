import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { getCurrentGitBranch } from '../../src/cli/ink/git-branch.js';

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err) => { if (err) reject(err); else resolve(); });
  });
}

describe('getCurrentGitBranch', () => {
  it('returns null for a directory that is not a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegrunt-notgit-'));
    try {
      expect(await getCurrentGitBranch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a nonexistent directory rather than throwing', async () => {
    await expect(getCurrentGitBranch('/definitely/does/not/exist/xyz')).resolves.toBeNull();
  });

  it('returns the branch name for a real git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegrunt-gitbranch-'));
    try {
      await run('git', ['init', '--initial-branch=main'], dir);
      await run('git', ['config', 'user.email', 'test@test.com'], dir);
      await run('git', ['config', 'user.name', 'Test'], dir);
      await run('git', ['commit', '--allow-empty', '-m', 'initial'], dir);
      expect(await getCurrentGitBranch(dir)).toBe('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
