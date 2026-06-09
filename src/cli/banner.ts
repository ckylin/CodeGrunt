import chalk from 'chalk';

// ── CODEGRUNT wordmark — pixel art ──────────────────────────────────────────

const GLYPHS: Record<string, string[]> = {
  C: [
    ' ▄███▄ ',
    ' ██    ',
    ' ██    ',
    ' ██    ',
    ' ▀███▀ ',
  ],
  O: [
    ' ▄███▄ ',
    ' ██  █ ',
    ' ██  █ ',
    ' ██  █ ',
    ' ▀███▀ ',
  ],
  D: [
    ' ████▄ ',
    ' ██  █ ',
    ' ██  █ ',
    ' ██  █ ',
    ' ████▀ ',
  ],
  E: [
    ' █████ ',
    ' ██    ',
    ' ████  ',
    ' ██    ',
    ' █████ ',
  ],
  G: [
    ' ▄███▄ ',
    ' ██    ',
    ' ██ ██ ',
    ' ██  █ ',
    ' ▀███▀ ',
  ],
  R: [
    ' ████▄ ',
    ' ██  █ ',
    ' ████▀ ',
    ' ██▄   ',
    ' ██  █ ',
  ],
  U: [
    ' █   █ ',
    ' █   █ ',
    ' █   █ ',
    ' █   █ ',
    ' ▀███▀ ',
  ],
  N: [
    ' █   █ ',
    ' ██  █ ',
    ' █ █ █ ',
    ' █  ██ ',
    ' █   █ ',
  ],
  T: [
    ' █████ ',
    '   █   ',
    '   █   ',
    '   █   ',
    '   █   ',
  ],
  ' ': [
    '   ',
    '   ',
    '   ',
    '   ',
    '   ',
  ],
};

const WORD = 'CODEGRUNT';

export function printBanner(model: string): void {
  const cols = process.stdout.columns || 80;
  const termH = process.stdout.rows || 24;

  // Blue accent
  const blue = (s: string) => chalk.hex('#4A90D9')(s);
  const dim = chalk.gray;
  const bold = chalk.bold;

  // Skip glyphs when terminal is too short
  const skipGlyphs = termH < 14;

  if (!skipGlyphs) {
    // Build the wordmark row by row
    const rows = Array.from({ length: 5 }, () => '');
    for (let i = 0; i < WORD.length; i++) {
      const ch = WORD[i];
      const glyph = GLYPHS[ch] ?? GLYPHS[' '];
      for (let r = 0; r < 5; r++) {
        rows[r] += (i > 0 ? ' ' : '') + glyph[r];
      }
    }

    // Centre the wordmark
    process.stdout.write('\n');
    for (const row of rows) {
      const pad = Math.max(0, Math.floor((cols - row.length) / 2));
      process.stdout.write(' '.repeat(pad) + blue(row) + '\n');
    }
    process.stdout.write('\n');
  }

  // ── Version/model info line ────────────────────────────────────────────
  process.stdout.write(
    '  ' +
    bold.white('CodeGrunt') +
    dim('  v0.1.2  ·  model: ') +
    blue(model) +
    dim('  ·  /help for commands') +
    '\n\n',
  );
}
