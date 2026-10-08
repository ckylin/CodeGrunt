import chalk from 'chalk';
import type { LLMProvider, CodeGruntConfig } from '../../types.js';
import type { ContextManager } from '../../core/context/manager.js';
import type { Skill } from '../skills.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

/** Commands by name and alias (case-insensitive), in registration order. */
export class CommandRegistry {
  private readonly byKey = new Map<string, SlashCommand>();
  private readonly commands: SlashCommand[] = [];

  /** Throws, leaving the registry untouched, if the name or any alias is already taken. */
  register(command: SlashCommand): void {
    const keys = [command.name, ...(command.aliases ?? [])].map((k) => k.toLowerCase());
    for (const key of keys) {
      if (this.byKey.has(key) || keys.indexOf(key) !== keys.lastIndexOf(key)) {
        throw new Error(`Duplicate slash command: /${key}`);
      }
    }
    for (const key of keys) this.byKey.set(key, command);
    this.commands.push(command);
  }

  get(nameOrAlias: string): SlashCommand | undefined {
    return this.byKey.get(nameOrAlias.toLowerCase());
  }

  list(): readonly SlashCommand[] {
    return this.commands;
  }
}

export const commandRegistry = new CommandRegistry();

export function registerCommands(commands: readonly SlashCommand[], registry = commandRegistry): void {
  for (const command of commands) registry.register(command);
}

export async function dispatchSlashCommand(
  registry: CommandRegistry,
  input: string,
  cwd: string,
  config: CodeGruntConfig,
  provider: LLMProvider,
  context: ContextManager,
  skills: Skill[] = [],
  currentSessionId?: string,
): Promise<SlashCommandResult> {
  if (!input.startsWith('/')) return { type: 'not_a_command' };

  const [cmd, ...rest] = input.slice(1).split(' ');
  const args = rest.join(' ').trim();

  const command = registry.get(cmd);
  if (!command?.run) {
    console.log(chalk.yellow(`Unknown command: /${cmd}. Type /help for available commands.`));
    return { type: 'handled' };
  }
  return command.run({ cwd, config, provider, context, skills, currentSessionId, rest, args });
}

export function handleSlashCommand(
  input: string,
  cwd: string,
  config: CodeGruntConfig,
  provider: LLMProvider,
  context: ContextManager,
  skills: Skill[] = [],
  currentSessionId?: string,
): Promise<SlashCommandResult> {
  return dispatchSlashCommand(commandRegistry, input, cwd, config, provider, context, skills, currentSessionId);
}
