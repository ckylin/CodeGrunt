// ── Danger Detection for execute_shell / write_file ────────────────────────
// Flags operations that deserve a stronger confirmation than the routine
// "accept this edit?" prompt: destructive shell commands and writes that
// land outside the project or in credential/VCS-internal paths. Detected
// operations force a second confirmation even when yes-for-all/auto trust
// mode is active — see confirmOrSkip/confirmShellOrSkip in
// process-tools-helpers.ts.
//
// This is a heuristic safety net, not a sandbox: it catches common
// destructive patterns, not every possible dangerous command.

import { relative, resolve, sep } from 'path';

// ── Shell command danger patterns ──────────────────────────────────────────

const DANGEROUS_SHELL_PATTERNS: RegExp[] = [
  // rm -rf / -fr / --recursive --force in any flag order or spelling
  /\brm\s+(-\w*[rf]\w*\s+)*-\w*r\w*f\w*\b/i,
  /\brm\s+(-\w*[rf]\w*\s+)*-\w*f\w*r\w*\b/i,
  /\brm\b[^&|;]*--recursive[^&|;]*--force\b/i,
  /\brm\b[^&|;]*--force[^&|;]*--recursive\b/i,
  // Windows recursive/forced delete
  /\b(del|erase)\s+\/[sfSF]*[sfSF]/i,
  /\brmdir\s+\/[sqSQ]*[sqSQ]/i,
  // Raw disk writes / filesystem creation
  /\bdd\s+.*\bof=/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bformat\s+[a-zA-Z]:/i,
  // Shell fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/,
  // Privilege escalation
  /\bsudo\b/i,
  /\brunas\b/i,
  // Recursive world-writable permissions
  /\bchmod\s+(-[rR]\s+)?0?777\b/i,
  /\bchmod\s+.*-[rR].*\b0?777\b/i,
  // Force-pushing / rewriting shared git history
  /\bgit\s+push\b[^&|;]*(--force\b|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  // Piping a remote download straight into a shell
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|powershell|pwsh)\b/i,
  // Writing directly to a block device
  />\s*\/dev\/(sd|hd|nvme|disk)/i,
  // Power state changes
  /\b(shutdown|reboot|poweroff|halt)\b/i,
];

/** Returns true if the shell command matches a known destructive pattern. */
export function isDangerousShellCommand(command: string): boolean {
  return DANGEROUS_SHELL_PATTERNS.some(re => re.test(command));
}

// ── Write-path danger checks ───────────────────────────────────────────────

// Directory names that hold VCS internals or credentials — writing inside
// them is almost never something the agent should do unprompted.
const SENSITIVE_DIR_SEGMENTS = new Set([
  '.git', '.ssh', '.aws', '.gnupg', '.docker', '.kube',
]);

// Filenames (basename, case-insensitive) that hold credentials/secrets
// regardless of which directory they live in.
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\.json)?$/i,
];

/**
 * Returns true if writing to `filePath` should be treated as dangerous:
 * the resolved path escapes the project root, or it targets a
 * credential/VCS-internal file or directory. Plain overwrites of existing
 * project files are intentionally NOT flagged — that's the normal editing
 * path and already goes through the standard diff-confirm flow.
 */
export function isDangerousWritePath(filePath: string, projectRoot: string): boolean {
  const abs = resolve(filePath);
  const rootAbs = resolve(projectRoot);

  const rel = relative(rootAbs, abs);
  const escapesRoot = rel.startsWith('..') || resolveIsAbsolute(rel);
  if (escapesRoot) return true;

  const segments = abs.split(sep).filter(Boolean);
  if (segments.some(seg => SENSITIVE_DIR_SEGMENTS.has(seg))) return true;

  const basename = segments[segments.length - 1] ?? '';
  return SENSITIVE_BASENAME_PATTERNS.some(re => re.test(basename));
}

function resolveIsAbsolute(rel: string): boolean {
  // path.relative() returns an absolute path when the two inputs are on
  // different Windows drives (e.g. "C:\..." vs "D:\...") — not a leading "..".
  return /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith(sep);
}
