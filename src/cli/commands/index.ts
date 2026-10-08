import { commandRegistry, registerCommands, handleSlashCommand } from './registry.js';
import { helpCommands } from './help.js';
import { usageCommands } from './usage.js';
import { sessionCommands } from './session.js';
import { memoryCommands } from './memory.js';
import { compactCommands } from './compact.js';
import { reviewCommands } from './review.js';
import { restoreCommands } from './restore.js';
import { hooksCommands } from './hooks.js';
import { preferenceCommands } from './preferences.js';
import { connectionCommands } from './connection.js';
import { configCommands } from './config-command.js';
import { projectCommands } from './project.js';
import { skillsCommands } from './skills-command.js';
import { mcpCommands } from './mcp.js';
import type { CommandDescriptor } from './types.js';

export type { CommandDescriptor, SlashCommand, SlashCommandResult, CommandContext } from './types.js';
export { handleSlashCommand };

registerCommands([
  ...helpCommands,
  ...usageCommands,
  ...sessionCommands,
  ...memoryCommands,
  ...compactCommands,
  ...reviewCommands,
  ...restoreCommands,
  ...hooksCommands,
  ...preferenceCommands,
  ...connectionCommands,
  ...configCommands,
  ...projectCommands,
  ...skillsCommands,
  ...mcpCommands,
]);

/**
 * Display order of the listed commands (/help, autocomplete). Descriptions live
 * on the command objects; hidden commands (/token) are dispatchable but not
 * listed. tests/cli/command-registry.test.ts fails if this list and the
 * registry drift apart.
 */
export const BUILTIN_COMMAND_ORDER: readonly string[] = [
  'init', 'model', 'config', 'skills', 'compact', 'resume', 'sessions', 'status', 'memory', 'hooks',
  'trust', 'restore', 'baseurl', 'search-engine', 'mcp', 'index', 'swebench', 'permissions', 'review',
  'clear', 'cost', 'cache', 'cost-report', 'balance', 'help', 'branch', 'tree', 'switch',
  'subagent-cache', 'effort', 'theme',
];

/** Canonical list of built-in slash commands (name without leading slash). */
export const BUILTIN_COMMANDS: CommandDescriptor[] = BUILTIN_COMMAND_ORDER.map((name) => {
  const command = commandRegistry.get(name);
  if (!command) throw new Error(`BUILTIN_COMMAND_ORDER names an unregistered command: ${name}`);
  return { name: command.name, desc: command.desc };
});
