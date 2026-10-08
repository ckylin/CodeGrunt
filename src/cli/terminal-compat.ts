// ── Legacy Windows Console Detection ─────────────────────────────────────
// The classic Windows console host (conhost.exe, running cmd.exe or
// powershell.exe directly — NOT Windows Terminal) has a fragile VT/ANSI
// cursor-repositioning parser. Ink's live-region redraw (via log-update)
// depends on that parser tracking the cursor correctly across repeated
// "move up N lines, clear, rewrite" sequences; under load (e.g. streaming
// LLM output token-by-token) conhost's parser can lose track and fall back
// to appending a new line per redraw instead of repainting in place —
// visually "one character in, one new line out". Modern terminal emulators
// (Windows Terminal, ConEmu, mintty/Git Bash, VS Code's integrated
// terminal, and effectively everything on macOS/Linux) implement VT parsing
// properly and don't hit this. output-channel.ts's render throttle reduces
// how often this fragile path gets exercised, but the only real fix for a
// user on plain conhost is switching terminal emulators — Microsoft's own
// guidance is that legacy conhost VT support is not going to be hardened
// further, Windows Terminal is the supported modern replacement.
//
// This module only detects the situation and prints an informational hint;
// it never changes rendering behavior itself.

/**
 * True when running on Windows under the legacy conhost.exe console host
 * directly (plain cmd.exe or powershell.exe window) rather than a modern
 * terminal emulator. Detection is via environment markers set by every
 * known VT-capable wrapper — absence of all of them on win32 means conhost
 * is rendering directly.
 */
export function isLegacyWindowsConsole(): boolean {
  if (process.platform !== 'win32') return false;
  const env = process.env;
  // Windows Terminal
  if (env['WT_SESSION']) return false;
  // ConEmu / Cmder
  if (env['ConEmuANSI'] === 'ON') return false;
  // VS Code / Cursor / other editor-embedded terminals (xterm.js-based)
  if (env['TERM_PROGRAM']) return false;
  // Git Bash / MSYS2 / Cygwin (mintty)
  if (env['MSYSTEM']) return false;
  // JetBrains terminal, and other TERM-setting emulators
  if (env['TERM'] && env['TERM'] !== 'dumb') return false;
  return true;
}

let hintShown = false;

/** Prints a one-time hint if running under a legacy Windows console and the
 *  hint hasn't already been suppressed. No-op on every other platform/
 *  terminal, and after the first call per process. */
export function maybeWarnLegacyWindowsConsole(write: (text: string) => void, muted: (s: string) => string): void {
  if (hintShown) return;
  if (process.env['CODEGRUNT_SUPPRESS_TERMINAL_HINT']) return;
  if (!isLegacyWindowsConsole()) return;
  hintShown = true;
  write(
    muted(
      '  [tip: rendering looks best in Windows Terminal — cmd.exe/PowerShell\'s ' +
      'built-in console can redraw streaming output as extra lines instead of ' +
      'updating in place. Set CODEGRUNT_SUPPRESS_TERMINAL_HINT=1 to hide this.]\n',
    ),
  );
}
