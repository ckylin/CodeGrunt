import chalk from 'chalk';
import { runAgentLoop } from '../core/agent/loop.js';
import { ContextManager } from '../core/context/manager.js';
import { DeepSeekProvider } from '../providers/deepseek/provider.js';
import { createInterruptController, getActiveInterruptCount } from '../utils/interrupt.js';

import { printError } from '../utils/display.js';
import { resolveAtReferences } from './at-resolver.js';
import { handleSlashCommand } from './commands.js';
import { printBanner } from './banner.js';
import { readMultilineInput } from './input.js';
import { loadSkills } from './skills.js';
import { saveConfig, supportsReasoning, CONTEXT_BUDGET, CHAT_CONTEXT_BUDGET } from '../config.js';
import { loadSessionSummary, readEntries } from '../core/memory/store.js';
import {
  createInitialHabitState, observeTurn, analyzeHabits, persistHabitUpdates,
  type HabitState,
} from '../core/memory/habits.js';
import type { CodeGruntConfig, LLMProvider } from '../types.js';

// ── Harness-style: Pipeline / Events / Observability ─────────────────────
import { getLogger } from '../core/observability/logger.js';
import { getDefaultMetrics } from '../core/observability/metrics.js';

const log = getLogger('repl');

export async function startRepl(initialConfig: CodeGruntConfig, initialProvider: LLMProvider): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: interactive REPL requires a TTY. Use `codegrunt "<task>"` for non-interactive mode.\n');
    process.exit(1);
  }

  const cwd = process.cwd();
  const budget = supportsReasoning(initialConfig.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
  const context = new ContextManager(budget);

  let config = initialConfig;
  let provider: LLMProvider = initialProvider;
  let skills = await loadSkills(cwd);

  const sessionSummary = await loadSessionSummary(cwd);
  if (sessionSummary) {
    const lines = sessionSummary.split('\n').length;
    process.stdout.write(chalk.gray(`  [memory: loaded ${lines}-line session summary]\n`));
  }

  // Load persisted user habits for injection into system prompt
  const userEntries = await readEntries('user');
  const userPreferences = userEntries.length > 0
    ? userEntries.map(e => e.body).join('\n')
    : undefined;
  if (userEntries.length > 0) {
    process.stdout.write(chalk.gray(`  [habits: ${userEntries.length} user preference${userEntries.length > 1 ? 's' : ''} loaded]\n`));
  }

  let habitState: HabitState = createInitialHabitState();

  const metrics = getDefaultMetrics();

  // SIGINT fires only during agent runs (Ink intercepts Ctrl+C during input).
  // When the interrupt controller is active the agent handles abort itself;
  // once it's gone we just exit cleanly.
  process.on('SIGINT', () => {
    if (getActiveInterruptCount() > 0) return; // let interrupt controller handle it
    process.stdout.write(chalk.gray('\nGoodbye.\n'));
    if (process.env.CODEGRUNT_TELEMETRY === '1') metrics.printSummary();
    process.exit(0);
  });

  printBanner(config.model);

  // ── Main REPL loop (iterative, not recursive — avoids stack growth) ──
  while (true) {
    const result = await readMultilineInput(cwd, config.model, skills, undefined, true);

    if (result.cancelled) {
      // PromptInput already handled the double-press guard; reaching here means
      // the user confirmed exit (second Ctrl+C within 2s).
      console.log(chalk.gray('\nGoodbye.'));
      if (process.env.CODEGRUNT_TELEMETRY === '1') metrics.printSummary();
      process.exit(0);
    }

    const raw = result.text;
    if (!raw) continue;

    if (raw === 'exit' || raw === 'quit') {
      console.log(chalk.gray('Goodbye.'));
      if (process.env.CODEGRUNT_TELEMETRY === '1') {
        metrics.printSummary();
      }
      process.exit(0);
    }

    // Slash commands — only if "/" is immediately followed by a letter (no space)
    if (raw.startsWith('/') && raw.length > 1 && raw[1] !== ' ') {
      const cmd = await handleSlashCommand(raw, cwd, config, provider, context, skills);

      if (cmd.type === 'model_changed' || cmd.type === 'config_changed') {
        config = cmd.config;
        provider = new DeepSeekProvider(config);

        // Adjust context budget when switching between chat/reasoner
        const newBudget = supportsReasoning(config.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
        context.setTokenBudget(newBudget);

        await saveConfig(config).catch(() => {});
        if (cmd.type === 'model_changed') {
          console.log(chalk.gray(`  Active model: ${chalk.cyan(config.model)}\n`));
        } else {
          console.log(chalk.gray('  Configuration applied.\n'));
        }
      } else if (cmd.type === 'skills_reload') {
        skills = await loadSkills(cwd);
        console.log(chalk.gray('Skills reloaded.\n'));
      }
      continue;
    }

    // @ references
    const { expanded: task, refs } = await resolveAtReferences(raw, cwd);
    if (refs.length > 0) {
      const labels = refs.map((r) => chalk.cyan(r.raw)).join(', ');
      process.stdout.write(chalk.gray(`  Injecting: ${labels}\n`));
    }

    const interrupt = createInterruptController();
    try {
      process.stdout.write('\n');
      await runAgentLoop({
        task, cwd, config, provider, context, skills,
        signal: interrupt.signal,
        memorySummary: sessionSummary ?? undefined,
        userPreferences,
        onTurnComplete: (signal) => {
          habitState = observeTurn(signal, habitState);
          const updates = analyzeHabits(habitState);
          if (updates.length > 0) persistHabitUpdates(updates).catch(() => {});
        },
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || interrupt.signal.aborted) {
        process.stdout.write(chalk.yellow('\nInterrupted.\n'));
      } else {
        printError(err instanceof Error ? err.message : String(err));
        log.error('Agent loop failed', { error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      interrupt.cleanup();
    }
  }
}
