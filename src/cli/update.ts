import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import { printError } from '../utils/display.js';
import { askOnce } from '../utils/prompt.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface NpmPackageInfo {
  version: string;
}

export interface UpdateOptions {
  /** Skip confirmation prompt */
  confirm: boolean;
  /** Only check for updates, do not install */
  checkOnly: boolean;
}

// ── Version utilities ────────────────────────────────────────────────────────

/**
 * Parse a semver string into [major, minor, patch].
 * Returns [0,0,0] for non-standard formats.
 */
function parseSemver(v: string): [number, number, number] {
  const parts = v.split('.');
  return [
    parseInt(parts[0], 10) || 0,
    parseInt(parts[1], 10) || 0,
    parseInt(parts[2], 10) || 0,
  ];
}

/** Returns true if version `a` is strictly newer than `b` */
function isNewer(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

// ── Current version ──────────────────────────────────────────────────────────

function getCurrentVersion(): string {
  try {
    // dist/cli/update.js → go up 2 levels to project root → package.json
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Fetch latest ─────────────────────────────────────────────────────────────

const NPM_REGISTRY = 'https://registry.npmjs.org/codegrunt/latest';

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(NPM_REGISTRY, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmPackageInfo;
    return data.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Install ──────────────────────────────────────────────────────────────────

function runNpmInstall(version: string): Promise<boolean> {
  return new Promise((resolve_p) => {
    const child = spawn('npm', ['install', '-g', `codegrunt@${version}`], {
      stdio: 'inherit',
      // shell:true on Windows so .cmd wrappers work
      shell: process.platform === 'win32',
    });

    child.on('close', (code) => {
      resolve_p(code === 0);
    });

    child.on('error', () => {
      resolve_p(false);
    });
  });
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const currentVersion = getCurrentVersion();
  const spinner = ora('Checking for updates...').start();

  const latestVersion = await fetchLatestVersion();

  if (!latestVersion) {
    spinner.fail('Unable to reach npm registry');
    console.log(chalk.gray('  Check your network connection and try again.'));
    process.exit(1);
  }

  spinner.stop();

  // ── Already up to date ──
  if (!isNewer(latestVersion, currentVersion)) {
    console.log(
      chalk.green('✓ codegrunt is up to date') +
      chalk.gray(`  (v${currentVersion})`),
    );
    return;
  }

  // ── Update available ──
  console.log();
  console.log(
    chalk.gray('  codegrunt  ') +
    chalk.yellow(`v${currentVersion}`) +
    chalk.gray('  →  ') +
    chalk.green(`v${latestVersion}`),
  );
  console.log();

  if (opts.checkOnly) {
    console.log(chalk.gray(`  Run ${chalk.cyan('codegrunt update')} to upgrade.`));
    return;
  }

  // ── Confirm ──
  if (!opts.confirm) {
    const answer = await askOnce(chalk.bold('Upgrade now? [y/N] '));
    if (!answer.toLowerCase().startsWith('y')) {
      console.log(chalk.gray('Update cancelled.'));
      return;
    }
  }

  // ── Install ──
  console.log(
    chalk.gray(`\nRunning ${chalk.cyan(`npm install -g codegrunt@${latestVersion}`)}...\n`),
  );

  const success = await runNpmInstall(latestVersion);

  if (success) {
    console.log();
    console.log(chalk.green(`✓ Upgraded to codegrunt@${latestVersion}`));
  } else {
    console.log();
    printError(
      `Upgrade failed. Try manually: ${chalk.cyan('npm install -g codegrunt@latest')}`,
    );
    process.exit(1);
  }
}
