// ── Git Branch Lookup (for the status bar) ──────────────────────────────────
// A tiny, isolated helper — deliberately not folded into snapshot/index.ts
// (which shells out for the Side-git SNAPSHOT repo, a completely different
// concern) or confirm.ts. Async + no throw: the status bar must degrade to
// "no branch shown" for a non-git directory, not break the REPL.

import { execFile } from 'child_process';

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/** Returns the current branch name, or null if `cwd` isn't a git repo (or
 *  git isn't installed, or HEAD is detached without a symbolic name, etc).
 *  Never throws. */
export async function getCurrentGitBranch(cwd: string): Promise<string | null> {
  try {
    const out = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = out.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}
