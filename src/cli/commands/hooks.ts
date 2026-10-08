import chalk from 'chalk';
import { getHookRegistry } from '../../core/hooks/registry.js';
import type { SlashCommand } from './types.js';

function printHooks(): void {
  const registry = getHookRegistry();
  const hooks = registry.list();
  const hooksDir = `${process.env.HOME ?? process.env.USERPROFILE ?? '~'}/.codegrunt/hooks/`;

  if (hooks.length === 0) {
    console.log(`\n${chalk.gray('No hooks loaded.')}`);
    console.log(chalk.gray(`Add scripts to ${chalk.cyan(hooksDir)}`));
    console.log(chalk.gray('Supported events:') + ' ' + chalk.cyan('user-prompt-submit  pre-tool-use  post-tool-use  stop'));
    console.log(chalk.gray('Supported formats:') + ' ' + chalk.cyan('.sh  .bash  .js  .mjs  .cjs'));
    console.log(`\n${chalk.gray('Example: pre-tool-use.sh — block dangerous shell commands')}\n`);
    return;
  }

  console.log(`\n${chalk.bold('Loaded Hooks')} ${chalk.gray(`(${hooks.length})`)}\n`);

  const events = ['user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'stop'] as const;
  for (const event of events) {
    const matching = hooks.filter(h => h.eventType === event);
    if (matching.length === 0) continue;
    console.log(`  ${chalk.cyan(event)}`);
    for (const h of matching) {
      console.log(`    ${chalk.gray('→')} ${h.name}`);
    }
  }

  console.log(`\n${chalk.gray(`Hook directory: ${hooksDir}`)}\n`);
}

export const hooksCommands: SlashCommand[] = [
  {
    name: 'hooks',
    desc: 'List loaded hook scripts from ~/.codegrunt/hooks/',
    run() {
      printHooks();
      return { type: 'handled' };
    },
  },
];
