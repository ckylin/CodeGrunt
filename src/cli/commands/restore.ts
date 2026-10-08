import chalk from 'chalk';
import { listSnapshots, restoreSnapshot } from '../../core/snapshot/index.js';
import { selectFromList } from '../../utils/select.js';
import type { SlashCommand } from './types.js';

async function handleRestore(rest: string[], cwd: string): Promise<void> {
  const snapshots = await listSnapshots(cwd);

  if (snapshots.length === 0) {
    console.log(chalk.gray('\nNo snapshots available for this directory.'));
    console.log(chalk.gray('Snapshots are created automatically after each coding turn.\n'));
    return;
  }

  const targetHash = rest[0];
  if (targetHash) {
    const entry = snapshots.find(s => s.hash.startsWith(targetHash));
    if (!entry) {
      console.log(chalk.yellow(`Snapshot "${targetHash}" not found.`));
      return;
    }
    try {
      await restoreSnapshot(cwd, entry.hash);
      console.log(chalk.green(`✓ Restored to snapshot ${chalk.cyan(entry.hash)}`));
      console.log(chalk.gray(`  ${entry.timestamp}  ${entry.message}`));
    } catch (err) {
      console.log(chalk.red(`Restore failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return;
  }

  // Interactive picker
  const choices = snapshots.map(s => ({
    label: `${chalk.cyan(s.hash)}  ${chalk.gray(s.timestamp)}  ${s.message}`,
    value: s.hash,
  }));
  const picked = await selectFromList('Restore to snapshot:', choices);
  if (!picked) return;

  const entry = snapshots.find(s => s.hash === picked)!;
  try {
    await restoreSnapshot(cwd, entry.hash);
    console.log(chalk.green(`✓ Restored to snapshot ${chalk.cyan(entry.hash)}`));
    console.log(chalk.gray(`  ${entry.timestamp}  ${entry.message}`));
    console.log(chalk.gray('  Files restored. Review changes with git diff.\n'));
  } catch (err) {
    console.log(chalk.red(`Restore failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

export const restoreCommands: SlashCommand[] = [
  {
    name: 'restore',
    desc: 'Restore working tree to a previous snapshot (/restore lists available)',
    async run({ rest, cwd }) {
      await handleRestore(rest, cwd);
      return { type: 'handled' };
    },
  },
];
