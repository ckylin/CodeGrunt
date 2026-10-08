import type { LLMProvider, CodeGruntConfig } from '../../types.js';
import type { ContextManager } from '../../core/context/manager.js';
import type { Skill } from '../skills.js';

export interface CommandDescriptor {
  name: string;
  desc: string;
}

export type SlashCommandResult =
  | { type: 'handled' }
  | { type: 'clear' }
  | { type: 'config_changed'; config: CodeGruntConfig }
  | { type: 'model_changed'; config: CodeGruntConfig }
  | { type: 'skills_reload' }
  | { type: 'not_a_command' };

export interface CommandContext {
  cwd: string;
  config: CodeGruntConfig;
  provider: LLMProvider;
  context: ContextManager;
  skills: Skill[];
  currentSessionId?: string;
  /** Words after the command name, split on single spaces (not trimmed). */
  rest: string[];
  /** `rest` joined with spaces and trimmed. */
  args: string;
}

export interface SlashCommand extends CommandDescriptor {
  /** Extra names that dispatch to this command but are never listed or autocompleted. */
  aliases?: string[];
  /** Dispatchable but left out of the listed commands (/help, autocomplete). */
  hidden?: boolean;
  /**
   * Omitted for commands that are listed here but handled before dispatch
   * (/resume is intercepted by the REPL); dispatch reports those as unknown.
   */
  run?(ctx: CommandContext): Promise<SlashCommandResult> | SlashCommandResult;
}
