#!/usr/bin/env node
process.title = 'CodeGrunt';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, supportsReasoning, CHAT_CONTEXT_BUDGET, CONTEXT_BUDGET } from '../config.js';
import { DeepSeekProvider } from '../providers/deepseek/provider.js';
import { ContextManager } from '../core/context/manager.js';
import { startRepl } from './repl.js';
import { runAgentLoop } from '../core/agent/loop.js';
import { createInterruptController } from '../utils/interrupt.js';
import { printError } from '../utils/display.js';
import { runSetup } from './setup.js';
import { installSkillFromZip, removeSkill, getGlobalSkillsDir } from './skills.js';

// ── Harness-style: Service Container & Event Bus ─────────────────────────
// These are initialized here and passed to sub-systems. The agent loop
// uses the Pipeline architecture internally.
import { randomUUID } from 'crypto';
import { getDefaultEventBus } from '../core/events/bus.js';
import { createLogger } from '../core/observability/logger.js';

const runId = randomUUID();
const log = createLogger('cli', runId);

const program = new Command();

program
  .name('codegrunt')
  .description('AI-powered CLI coding assistant')
  .version('0.1.2')
  .argument('[task]', 'One-shot task to execute (omit for interactive mode)')
  .option('-m, --model <model>', 'Model to use')
  .option('--max-tokens <n>', 'Max tokens per response', parseInt)
  .option('--resume [id]', 'Resume a previous session (omit id for interactive picker)')
  .action(async (task: string | undefined, opts: { model?: string; maxTokens?: number; resume?: string | boolean }) => {
    let config = await loadConfig();

    if (opts.model) config.model = opts.model;
    if (opts.maxTokens) config.maxTokens = opts.maxTokens;

    if (!config.apiKey) {
      config = await runSetup(config);
    }

    log.info('CodeGrunt starting', { model: config.model, runId, task: task ? task.slice(0, 80) : undefined });

    const provider = new DeepSeekProvider(config);
    const bus = getDefaultEventBus();

    // ── Resolve --resume to a session ID ─────────────────────────────────────
    let resumeSessionId: string | undefined;
    if (opts.resume !== undefined) {
      const { listSessions, loadSession, listAllSessions, formatSessionEntry } = await import('../core/session/store.js');
      const { selectFromList } = await import('../utils/select.js');
      const cwd = process.cwd();

      if (typeof opts.resume === 'string') {
        // --resume <id> passed directly
        resumeSessionId = opts.resume;
      } else {
        // --resume with no id — show interactive picker
        const sessions = await listSessions(cwd);
        if (sessions.length === 0) {
          process.stdout.write(chalk.yellow('No saved sessions found for this directory.\n'));
        } else {
          const choices = sessions.map(s => ({ label: formatSessionEntry(s), value: s.id }));
          const picked = await selectFromList('Resume session:', choices);
          if (picked) resumeSessionId = picked;
        }
      }
    }

    // No bus.on('error') handler here — Logger already writes errors to stderr
    // and emitting log.error from a bus error handler creates an infinite loop.

    if (task) {
      // One-shot mode
      const budget = supportsReasoning(config.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
      const context = new ContextManager(budget);
      const interrupt = createInterruptController();
      try {
        await runAgentLoop({
          task,
          cwd: process.cwd(),
          config,
          provider,
          context,
          signal: interrupt.signal,
        });
        process.stdout.write('\n');
        log.info('One-shot task completed');
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || interrupt.signal.aborted) {
          process.stdout.write(chalk.yellow('\nInterrupted.\n'));
          log.info('One-shot task interrupted by user');
        } else {
          printError(err instanceof Error ? err.message : String(err));
          bus.emit({
            type: 'error',
            source: 'cli',
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: Date.now(),
          });
          process.exit(1);
        }
      } finally {
        interrupt.cleanup();
      }
    } else {
      // Interactive REPL mode
      await startRepl(config, provider, resumeSessionId);
    }
  });

program
  .command('update')
  .description('Check for updates and upgrade to the latest version')
  .option('-c, --check', 'Only check for updates, do not install')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts: { check?: boolean; yes?: boolean }) => {
    const { runUpdate } = await import('./update.js');
    await runUpdate({ confirm: opts.yes ?? false, checkOnly: opts.check ?? false });
  });

program
  .command('skills')
  .description('Manage skills (add, remove, list)')
  .argument('<action>', 'Action: add | remove | list')
  .argument('[name]', 'Skill name (for remove) or zip path (for add with -f)')
  .option('-f, --file <path>', 'Install a skill from a .zip file')
  .action(async (action: string, name: string | undefined, opts: { file?: string }) => {
    if (action === 'add' || action === 'install') {
      const zipPath = opts.file || name;
      if (!zipPath) {
        console.log(chalk.yellow('Usage: codegrunt skills add -f <path-to-skill.zip>'));
        process.exit(1);
      }
      try {
        const result = await installSkillFromZip(zipPath);
        console.log(chalk.green(`\n✓ Skill "${result.name}" installed (${result.fileCount} files)`));
        console.log(chalk.gray(`  Directory: ${getGlobalSkillsDir()}/${result.name}`));
        console.log(chalk.gray(`  Start CodeGrunt and use /${result.name} to run it.`));
      } catch (err) {
        console.log(chalk.red('\nFailed to install skill: ' + (err instanceof Error ? err.message : String(err))));
        process.exit(1);
      }
    } else if (action === 'remove' || action === 'rm') {
      if (!name || name.startsWith('-')) {
        console.log(chalk.yellow('Usage: codegrunt skills remove <skill-name>'));
        process.exit(1);
      }
      try {
        await removeSkill(name);
        console.log(chalk.green(`\n✓ Skill "${name}" removed.`));
        console.log(chalk.gray(`  Global dir: ${getGlobalSkillsDir()}`));
      } catch (err) {
        console.log(chalk.red('\nFailed to remove skill: ' + (err instanceof Error ? err.message : String(err))));
        process.exit(1);
      }
    } else if (action === 'list' || action === 'ls') {
      const { loadSkills } = await import('./skills.js');
      const skills = await loadSkills(process.cwd());
      if (skills.length === 0) {
        console.log(chalk.gray('No skills installed.'));
        console.log(chalk.gray(`Global skills dir: ${getGlobalSkillsDir()}`));
      } else {
        console.log(chalk.bold(`\nSkills (${skills.length})\n`));
        const maxLen = Math.max(...skills.map((s) => s.name.length));
        for (const skill of skills) {
          const src = skill.source === 'project' ? chalk.blue('[project]') : chalk.gray('[global]');
          const desc = skill.description ? chalk.gray(` — ${skill.description}`) : '';
          console.log(`  ${chalk.cyan(skill.name.padEnd(maxLen))}  ${src}${desc}`);
        }
        console.log('');
      }
    } else {
      console.log(chalk.yellow(`Unknown action: ${action}`));
      console.log(chalk.gray('Available: skills add -f <path> | skills remove <name> | skills list'));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
