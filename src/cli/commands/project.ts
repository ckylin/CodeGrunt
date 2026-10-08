import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import { runInit } from '../init.js';
import { buildIndex, loadIndex } from '../../core/index/index.js';
import { exportSwebenchPrediction } from '../../core/swebench/export.js';
import {
  loadWorkspacePermissions, setToolPermission, resetToolPermission, type PermissionAction,
} from '../../core/permissions/index.js';
import type { SlashCommand } from './types.js';

// /swebench <instance-id>       — export current working-tree diff as a SWE-bench prediction
// /swebench run <instance-id>   — alias for the above

async function handleSwebench(rest: string[], cwd: string, config: CodeGruntConfig): Promise<void> {
  const args = rest[0]?.toLowerCase() === 'run' ? rest.slice(1) : rest;
  const instanceId = args[0];

  if (!instanceId) {
    console.log(chalk.yellow('Usage: /swebench <instance-id>'));
    return;
  }

  try {
    const { outputPath, patchLength } = await exportSwebenchPrediction({
      cwd,
      instanceId,
      modelName: config.model,
    });
    console.log(chalk.green(`✓ Exported prediction for ${chalk.cyan(instanceId)}`));
    console.log(chalk.gray(`  ${outputPath}  (${patchLength} bytes of diff)`));
  } catch (err) {
    console.log(chalk.red(`SWE-bench export failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// /permissions                       — show current .codegrunt/permissions.json
// /permissions set <tool> <action>   — set a tool's permission (allow|deny|ask)
// /permissions reset <tool>          — remove a tool's permission override

const PERMISSION_ACTIONS = ['allow', 'deny', 'ask'] as const;

async function handlePermissions(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (sub === 'set') {
    const toolName = rest[1];
    const action = rest[2]?.toLowerCase();
    if (!toolName || !action || !PERMISSION_ACTIONS.includes(action as PermissionAction)) {
      console.log(chalk.yellow('Usage: /permissions set <tool> <allow|deny|ask>'));
      return;
    }
    const updated = await setToolPermission(cwd, toolName, action as PermissionAction);
    console.log(chalk.green(`✓ ${toolName} → ${action}`));
    console.log(chalk.gray(JSON.stringify(updated, null, 2)));
    return;
  }

  if (sub === 'reset') {
    const toolName = rest[1];
    if (!toolName) {
      console.log(chalk.yellow('Usage: /permissions reset <tool>'));
      return;
    }
    const updated = await resetToolPermission(cwd, toolName);
    console.log(chalk.green(`✓ Removed permission override for ${toolName}`));
    console.log(chalk.gray(JSON.stringify(updated, null, 2)));
    return;
  }

  // Default: show current permissions
  const permissions = await loadWorkspacePermissions(cwd);
  if (!permissions || Object.keys(permissions.tools).length === 0) {
    console.log(chalk.gray('\nNo workspace permissions configured (.codegrunt/permissions.json).'));
    console.log(chalk.gray('All tools defer to the current trust mode (/trust).\n'));
    return;
  }
  console.log(chalk.bold('\nWorkspace permissions (.codegrunt/permissions.json):\n'));
  for (const [tool, action] of Object.entries(permissions.tools)) {
    const label = action === 'deny' ? chalk.red(action) : action === 'ask' ? chalk.yellow(action) : chalk.green(action);
    console.log(`  ${chalk.cyan(tool)}: ${label}`);
  }
  console.log();
}

async function handleIndex(cwd: string, args: string): Promise<void> {
  const semantic = args.includes('--semantic') || args.includes('-s');
  const existing = await loadIndex(cwd);
  if (existing) {
    const age = Math.round((Date.now() - new Date(existing.builtAt).getTime()) / 60000);
    const semLabel = existing.semantic ? ' [semantic]' : '';
    console.log(chalk.gray(`\n  Existing index: ${existing.symbols.length} symbols, ${existing.files.length} files${semLabel}, built ${age}m ago`));
  }

  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  let spinnerMsg = semantic ? 'Building index with semantic vectors…' : 'Building index…';
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${chalk.gray(`${spinnerChars[spinnerIdx]} ${spinnerMsg}`)}`);
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  try {
    await buildIndex(cwd, { semantic, onProgress: msg => { spinnerMsg = msg; } });
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    const idx = await loadIndex(cwd);
    const semInfo = idx?.semantic ? ' [semantic vectors]' : '';
    console.log(chalk.green(`✓ Code index built${semInfo}`) + chalk.gray(` — ${idx?.symbols.length ?? 0} symbols, ${idx?.files.length ?? 0} files\n`));
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(chalk.red(`Index build failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

export const projectCommands: SlashCommand[] = [
  {
    name: 'init',
    desc: 'Analyze codebase and generate a CODEGRUNT.md project guide',
    async run({ cwd, config, provider, args }) {
      await runInit(cwd, config, provider, args);
      return { type: 'handled' };
    },
  },
  {
    name: 'index',
    desc: 'Build or update the code symbol index for this project (--semantic for vector search)',
    async run({ cwd, args }) {
      await handleIndex(cwd, args);
      return { type: 'handled' };
    },
  },
  {
    name: 'swebench',
    desc: 'Export current session diff as a SWE-bench prediction (/swebench <instance-id>)',
    async run({ rest, cwd, config }) {
      await handleSwebench(rest, cwd, config);
      return { type: 'handled' };
    },
  },
  {
    name: 'permissions',
    desc: 'View or set per-tool permissions: /permissions | set <tool> <allow|deny|ask> | reset <tool>',
    async run({ rest, cwd }) {
      await handlePermissions(rest, cwd);
      return { type: 'handled' };
    },
  },
];
