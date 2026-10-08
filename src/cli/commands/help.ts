import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import type { Skill } from '../skills.js';
import { printPaged } from '../../utils/pager.js';
import type { SlashCommand } from './types.js';

async function printHelp(config: CodeGruntConfig, skills: Skill[] = []): Promise<void> {
  const skillsSection = skills.length > 0
    ? `\n${chalk.bold('Skills')}\n\n` +
      skills.map((s) =>
        `  ${chalk.cyan('/' + s.name)}${' '.repeat(Math.max(1, 18 - s.name.length - 1))}${s.description ? chalk.gray(` — ${s.description}`) : chalk.gray(`(${s.source})`)}`
      ).join('\n') + '\n'
    : '';
  await printPaged(`
${chalk.bold('Slash Commands')}

  ${chalk.cyan('/init')}              Analyze the codebase and generate a CODEGRUNT.md project guide
  ${chalk.cyan('/model')}             Switch model interactively
  ${chalk.cyan('/model <id>')}        Switch to a specific model  (e.g. /model deepseek-v4-pro)
  ${chalk.cyan('/config')}            Show current configuration
  ${chalk.cyan('/config <key> [val]')} Set a config value interactively or directly
                        Keys: ${chalk.gray('temperature  maxtokens  topp  frequencypenalty  presencepenalty  reasoning')}
  ${chalk.cyan('/reasoning')}         Set reasoning effort for R1 models (low/medium/high)
  ${chalk.cyan('/effort <level>')}    Shortcut: /effort low | /effort medium | /effort high
  ${chalk.cyan('/cost')}              Show session token usage and cost (DeepSeek pricing)
  ${chalk.cyan('/status')}            Show session status, cache hit rate, and context size
  ${chalk.cyan('/sessions')}          List saved sessions for this directory
  ${chalk.cyan('/sessions delete <id>')} Delete a saved session
  ${chalk.cyan('/resume')}            Resume a previous session (interactive picker)
  ${chalk.cyan('/resume <id>')}       Resume a specific session by ID
  ${chalk.cyan('/balance')}           Show account balance, today's & this month's usage
  ${chalk.cyan('/skills')}            List and manage skills (create, list)
  ${chalk.cyan('/review')}            Review session changes for logic issues
  ${chalk.cyan('/help')}              Show this help message
  ${chalk.cyan('/clear')}             Clear conversation context
  ${chalk.cyan('/compact')}           Summarize and compress conversation history to save tokens
  ${chalk.cyan('/memory')}            Show persistent memory entries and last session summary
  ${chalk.cyan('/memory delete <id>')} Delete a memory entry by id
  ${chalk.cyan('/hooks')}             List loaded hook scripts
  ${chalk.cyan('/trust')}             Set trust mode: plan (read-only) / code (confirm) / auto (yes-all)
  ${chalk.cyan('/trust <mode>')}      Switch directly: /trust plan | /trust code | /trust auto
  ${chalk.cyan('/restore')}           List and restore working tree to a previous snapshot
  ${chalk.cyan('/restore <hash>')}    Restore to a specific snapshot by hash prefix
  ${chalk.cyan('/swebench <id>')}     Export current session diff as a SWE-bench prediction (JSONL)
  ${chalk.cyan('/permissions')}       Show per-tool permission overrides
  ${chalk.cyan('/permissions set <tool> <allow|deny|ask>')}  Set a tool's permission
  ${chalk.cyan('/permissions reset <tool>')}                 Remove a tool's permission override
${skillsSection}
${chalk.bold('@ References')}

  ${chalk.cyan('@<file>')}        Inject file contents into your message  (e.g. @src/index.ts)
  ${chalk.cyan('@<directory>')}   Inject directory listing                (e.g. @src/)
  ${chalk.cyan('@<url>')}         Fetch and inject webpage content        (e.g. @https://example.com)

${chalk.bold('Current')}

  temperature: ${chalk.cyan(String(config.temperature))}  max_tokens: ${chalk.cyan(String(config.maxTokens))}  top_p: ${chalk.cyan(String(config.topP ?? 1))}${config.reasoningEffort ? chalk.gray(`  reasoning: ${config.reasoningEffort}`) : ''}

${chalk.bold('Other')}

  ${chalk.cyan('exit')} / ${chalk.cyan('quit')}   Exit CodeGrunt
  ${chalk.cyan('Ctrl+C')}         Interrupt a running task
`);
}

export const helpCommands: SlashCommand[] = [
  {
    name: 'help',
    desc: 'Show full help message',
    async run({ config, skills }) {
      await printHelp(config, skills);
      return { type: 'handled' };
    },
  },
];
