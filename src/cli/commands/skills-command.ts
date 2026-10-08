import chalk from 'chalk';
import type { Skill } from '../skills.js';
import { getGlobalSkillsDir, createSkill } from '../skills.js';
import { withPrompt } from '../../utils/prompt.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

// /skills              — list all loaded skills
// /skills create <name> — interactively create a new skill in ~/.codegrunt/skills/

async function handleSkills(
  rest: string[],
  skills: Skill[],
): Promise<SlashCommandResult> {
  const sub = rest[0]?.toLowerCase();
  const name = rest.slice(1).join(' ').trim();

  if (sub === 'create') {
    if (!name) {
      console.log(chalk.yellow('Usage: /skills create <name>'));
      console.log(chalk.gray('Example: /skills create my-skill'));
      return { type: 'handled' };
    }

    console.log(chalk.gray(`\nCreating skill "${chalk.cyan(name)}" in ${chalk.gray(getGlobalSkillsDir())}\n`));

    const { desc, content } = await withPrompt(async (ask) => {
      console.log(chalk.gray('Enter a short description (optional, press Enter to skip):'));
      const desc = (await ask(chalk.bold('Description: '))).trim();

      console.log(chalk.gray('\nEnter the skill content (instructions/prompt that will be sent to the model):'));
      console.log(chalk.gray('Type your content and press Enter. Multi-line is supported —'));
      console.log(chalk.gray('just keep typing and press Enter on an empty line to finish.\n'));

      const lines: string[] = [];
      while (true) {
        const line = await ask('');
        if (line === '') break;
        lines.push(line);
      }
      return { desc, content: lines.join('\n').trim() };
    });
    if (!content) {
      console.log(chalk.yellow('Skill content cannot be empty. Aborted.'));
      return { type: 'handled' };
    }

    try {
      const fileName = await createSkill(name, desc || '', content);
      console.log(chalk.green(`\n✓ Skill "${name}" created: ${fileName}`));
      console.log(chalk.gray(`  Directory: ${getGlobalSkillsDir()}`));
      console.log(chalk.gray(`  Use as /${name} immediately.`));
      return { type: 'skills_reload' };
    } catch (err) {
      console.log(chalk.red(`\nFailed to create skill: ${err instanceof Error ? err.message : String(err)}`));
    }

    return { type: 'handled' };
  }

  // /skills — list all skills
  if (skills.length === 0) {
    console.log(`\n${chalk.gray('No skills loaded.')}`);
    console.log(chalk.gray(`Create one with ${chalk.cyan('/skills create <name>')}`));
    console.log(chalk.gray(`Or add .md files to ${chalk.gray(getGlobalSkillsDir())}`));
    console.log(chalk.gray(`Project skills: ${chalk.gray('.codegrunt/skills/')} (also reads .claude/skills/ for Claude Code compat)`));
    return { type: 'handled' };
  }

  console.log(`\n${chalk.bold('Skills')}\n`);

  const maxNameLen = Math.max(...skills.map((s) => s.name.length));
  for (const skill of skills) {
    const sourceLabel = skill.source === 'project' ? chalk.blue('[project]') : chalk.gray('[global]');
    const desc = skill.description ? chalk.gray(` — ${skill.description}`) : '';
    const namePadded = chalk.cyan('/' + skill.name.padEnd(maxNameLen));
    console.log(`  ${namePadded}  ${sourceLabel}${desc}`);
  }

  console.log(`\n${chalk.gray('Use /<skill-name> to run a skill')}`);
  console.log(chalk.gray(`Create: ${chalk.cyan('/skills create <name>')}`));
  console.log(chalk.gray(`Global dir: ${chalk.gray(getGlobalSkillsDir())}`));
  console.log(chalk.gray(`Project dir: ${chalk.gray('.codegrunt/skills/')}`));
  console.log(chalk.gray(`Claude-format dir: ${chalk.gray('.claude/skills/')}`));

  return { type: 'handled' };
}

export const skillsCommands: SlashCommand[] = [
  {
    name: 'skills',
    desc: 'List and manage skills',
    run: ({ rest, skills }) => handleSkills(rest, skills),
  },
];
