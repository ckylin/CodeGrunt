import chalk from 'chalk';
import { loadSessionSummary, deleteEntry, listEntries } from '../../core/memory/store.js';
import { printPaged } from '../../utils/pager.js';
import type { SlashCommand } from './types.js';

async function handleMemoryCommand(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (sub === 'delete' && rest[1]) {
    const deleted = await deleteEntry(rest[1]);
    if (deleted) {
      console.log(chalk.green(`✓ Deleted memory entry ${rest[1]}`));
    } else {
      console.log(chalk.yellow(`Entry "${rest[1]}" not found.`));
    }
    return;
  }

  const [summary, entries] = await Promise.all([
    loadSessionSummary(cwd),
    listEntries(),
  ]);

  const lines: string[] = [];

  if (summary) {
    lines.push('', chalk.bold('Last Session Summary'), '', chalk.gray(summary));
  } else {
    lines.push('', chalk.gray('No session summary saved yet. Run /compact to create one.'));
  }

  if (entries.length > 0) {
    lines.push('', chalk.bold('Memory Entries'), '');
    for (const e of entries) {
      lines.push(`  ${chalk.cyan(`[${e.id}]`)} ${chalk.bold(e.name)} ${chalk.gray(`(${e.type})`)}`);
      lines.push(`  ${chalk.gray(e.description)}`);
      const preview = e.body.length > 120 ? e.body.slice(0, 120) + '…' : e.body;
      lines.push(`  ${preview}`, '');
    }
    lines.push(chalk.gray('  /memory delete <id>   to remove an entry'));
  } else {
    lines.push('', chalk.gray('No memory entries. Ask the agent to remember something using memory_write.'));
  }
  lines.push('');

  await printPaged(lines.join('\n'));
}

export const memoryCommands: SlashCommand[] = [
  {
    name: 'memory',
    desc: 'Show persistent memory entries and last session summary',
    async run({ rest, cwd }) {
      await handleMemoryCommand(rest, cwd);
      return { type: 'handled' };
    },
  },
];
