// Directory names skipped when walking a project tree. The presets differ on
// purpose (each walker has its own needs), so they are named rather than merged.

/** Used by tools and @-references: build output, caches and VCS metadata. */
export const SKIP_DIRS_DEFAULT: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__', '.cache',
]);

/** File-path autocomplete also hides coverage reports. */
export const SKIP_DIRS_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__', 'coverage',
]);

/** The symbol index skips generated output and its own data directory. */
export const SKIP_DIRS_INDEX: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', '.codegrunt',
]);

/** /init scans for project context, so it also skips virtualenvs and editor folders. */
export const SKIP_DIRS_INIT: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__', '.cache',
  'coverage', '.nyc_output', 'build', 'target', '.turbo',
  '.codegrunt', 'venv', '.venv', '.idea', '.vscode',
]);
