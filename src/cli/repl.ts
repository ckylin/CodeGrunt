import chalk from 'chalk';
import { runAgentLoop } from '../core/agent/loop.js';
import { ContextManager } from '../core/context/manager.js';
import { DeepSeekProvider } from '../providers/deepseek/provider.js';
import { createInterruptController, getActiveInterruptCount } from '../utils/interrupt.js';

import { printTypedError } from '../utils/display.js';
import { resolveAtReferences } from './at-resolver.js';
import { handleSlashCommand } from './commands.js';
import { printBanner } from './banner.js';
import { getMcpManager } from '../core/mcp/manager.js';
import { getToolRegistry } from '../core/tools/registry.js';
import { mountApp } from './ink/App.js';
import { getCurrentGitBranch } from './ink/git-branch.js';
import { write as chWrite } from './ink/output-channel.js';
import { loadSkills } from './skills.js';
import { saveConfig, supportsReasoning, CONTEXT_BUDGET, CHAT_CONTEXT_BUDGET } from '../config.js';
import { loadSessionSummary, readEntries } from '../core/memory/store.js';
import { saveSession, listSessions, loadSession, formatSessionEntry } from '../core/session/store.js';
import { loadBranchTree, saveBranchTree, recordCheckpoint, getCurrentBranchId } from '../core/session/branching.js';
import { selectFromList } from '../utils/select.js';
import { detectSystemLanguage } from '../utils/locale.js';
import {
  createInitialHabitState, observeTurn, analyzeHabits, persistHabitUpdates,
  type HabitState,
} from '../core/memory/habits.js';
import type { CodeGruntConfig, LLMProvider } from '../types.js';

// ── Harness-style: Pipeline / Events / Observability ─────────────────────
import { getLogger } from '../core/observability/logger.js';
import { getDefaultMetrics } from '../core/observability/metrics.js';
import { getHookRegistry } from '../core/hooks/registry.js';
import { writeCrashReport, type CrashReportContext } from '../core/observability/crash-report.js';
import { applyTheme } from '../utils/constants.js';
import { getSessionUsage } from '../core/usage.js';

const log = getLogger('repl');

/** Writes a local crash report if config.crashReportOnError is enabled.
 *  No-op otherwise. `config` is read fresh from the closure at call time,
 *  not captured, since /config can change crashReportOnError mid-session. */
async function maybeWriteCrashReport(
  err: unknown,
  ctx: CrashReportContext & { crashReportOnError?: boolean },
): Promise<void> {
  if (!ctx.crashReportOnError) return;
  const path = await writeCrashReport(err, ctx);
  if (path) {
    process.stderr.write(chalk.gray(`  crash report written to ${path}\n`));
  }
}

export async function startRepl(
  initialConfig: CodeGruntConfig,
  initialProvider: LLMProvider,
  resumeSessionId?: string,
): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: interactive REPL requires a TTY. Use `codegrunt "<task>"` for non-interactive mode.\n');
    process.exit(1);
  }

  applyTheme(initialConfig.theme ?? 'dark');

  const cwd = process.cwd();
  const budget = supportsReasoning(initialConfig.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
  const context = new ContextManager(budget);
  // Detect system language once at startup — reused on every agent turn.
  const systemLanguage = detectSystemLanguage();

  // Sync search engine config to env so tools can read it without DI
  if (initialConfig.searchEngine) process.env['CODEGRUNT_SEARCH_ENGINE'] = initialConfig.searchEngine;
  if (initialConfig.searxngUrl)   process.env['CODEGRUNT_SEARXNG_URL'] = initialConfig.searxngUrl;

  // ── Pre-mount setup ──────────────────────────────────────────────────────
  // Everything in this section writes directly to stdout (not through
  // output-channel.ts) and that's correct: the persistent App hasn't
  // mounted yet, so there's no live region to corrupt. Once mountApp() is
  // called below, every subsequent write in this function goes through
  // chWrite() instead.

  // Connect MCP servers from ~/.codegrunt/mcp.json, register their tools
  const mcpManager = getMcpManager();
  const mcpTools = await mcpManager.connectAll().catch(() => []);
  if (mcpTools.length > 0) {
    const registry = getToolRegistry();
    for (const tool of mcpTools) registry.register(tool, 'mcp');
    process.stdout.write(chalk.gray(`  [mcp: ${mcpTools.length} tool${mcpTools.length > 1 ? 's' : ''} loaded]\n`));
  }

  let config = initialConfig;
  let provider: LLMProvider = initialProvider;
  let skills = await loadSkills(cwd);

  // ── Session persistence state ─────────────────────────────────────────────
  let currentSessionId: string | undefined = resumeSessionId;

  // Resume a previous session if requested
  if (resumeSessionId) {
    const session = await loadSession(resumeSessionId);
    if (session) {
      context.setMessages(session.messages);
      process.stdout.write(chalk.gray(`  [session: resumed "${session.title.slice(0, 60)}" — ${session.messageCount} messages]\n`));
    } else {
      process.stdout.write(chalk.yellow(`  [session: id "${resumeSessionId}" not found, starting fresh]\n`));
      currentSessionId = undefined;
    }
  }

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
  const gitBranch = await getCurrentGitBranch(cwd);

  printBanner(config.model);

  // ── Mount the persistent App ─────────────────────────────────────────────
  // From here on, the input box stays mounted for the entire session — it no
  // longer unmounts while the agent runs (see output-channel.ts's module doc
  // for why that used to be necessary). All further terminal output in this
  // function goes through chWrite()/app.set*() instead of raw stdout writes.
  const app = mountApp({
    cwd,
    model: config.model,
    gitBranch,
    skills,
    showMeta: true,
  });

  // Points at the InterruptController for whichever turn is currently
  // running, so PromptInput's Esc/Ctrl+C-while-busy (reported via
  // onCancelBusy) aborts the RIGHT turn. Null while idle between turns.
  let activeInterrupt: ReturnType<typeof createInterruptController> | null = null;
  app.onCancelBusy(() => activeInterrupt?.abort());

  function exitRepl(message: string): never {
    app.unmount();
    console.log(chalk.gray(message));
    if (process.env.CODEGRUNT_TELEMETRY === '1') metrics.printSummary();
    process.exit(0);
  }

  // SIGINT here means something external sent the signal while idle (no
  // turn running — an active turn's Esc/Ctrl+C is handled by PromptInput's
  // busy-mode key handling instead, via onCancelBusy above). Unmount before
  // printing so the final "Goodbye" doesn't land inside a live Ink region
  // that's about to disappear anyway.
  process.on('SIGINT', () => {
    if (getActiveInterruptCount() > 0) return; // let interrupt controller handle it
    exitRepl('\nGoodbye.');
  });

  // ── Main REPL loop (iterative, not recursive — avoids stack growth) ──
  while (true) {
    const result = await app.promptForInput();

    if (result.cancelled) {
      // PromptInput already handled the double-press guard; reaching here means
      // the user confirmed exit (second Ctrl+C within 2s).
      exitRepl('\nGoodbye.');
    }

    const raw = result.text;
    if (!raw) continue;

    if (raw === 'exit' || raw === 'quit') {
      exitRepl('Goodbye.');
    }

    // Slash commands — only if "/" is immediately followed by a letter (no space)
    if (raw.startsWith('/') && raw.length > 1 && raw[1] !== ' ') {
      // Handle /resume inline — needs direct context access
      const trimmed = raw.slice(1).trim();
      if (trimmed === 'resume' || trimmed.startsWith('resume ')) {
        const parts = trimmed.split(/\s+/);
        const targetId = parts[1];
        if (targetId) {
          const session = await loadSession(targetId);
          if (session) {
            context.setMessages(session.messages);
            currentSessionId = session.id;
            chWrite(chalk.gray(`  [session: resumed "${session.title.slice(0, 60)}" — ${session.messageCount} messages]\n`));
          } else {
            chWrite(chalk.yellow(`  Session "${targetId}" not found.\n`));
          }
        } else {
          // Interactive picker
          const sessions = await listSessions(cwd);
          if (sessions.length === 0) {
            chWrite(chalk.gray('  No saved sessions for this directory.\n'));
          } else {
            const choices = sessions.map(s => ({ label: formatSessionEntry(s), value: s.id }));
            const picked = await selectFromList('Resume session:', choices);
            if (picked) {
              const session = await loadSession(picked);
              if (session) {
                context.setMessages(session.messages);
                currentSessionId = session.id;
                chWrite(chalk.gray(`  [session: resumed "${session.title.slice(0, 60)}" — ${session.messageCount} messages]\n`));
              }
            }
          }
        }
        continue;
      }

      const cmd = await handleSlashCommand(raw, cwd, config, provider, context, skills, currentSessionId);

      if (cmd.type === 'model_changed' || cmd.type === 'config_changed') {
        config = cmd.config;
        provider = new DeepSeekProvider(config);
        applyTheme(config.theme ?? 'dark');

        // Sync search engine config to env so tools can read it without DI
        if (config.searchEngine) process.env['CODEGRUNT_SEARCH_ENGINE'] = config.searchEngine;
        if (config.searxngUrl)   process.env['CODEGRUNT_SEARXNG_URL'] = config.searxngUrl;

        // Adjust context budget when switching between chat/reasoner
        const newBudget = supportsReasoning(config.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
        context.setTokenBudget(newBudget);

        await saveConfig(config).catch(() => {});
        if (cmd.type === 'model_changed') {
          chWrite(chalk.gray(`  Active model: ${chalk.cyan(config.model)}\n`));
        } else {
          chWrite(chalk.gray('  Configuration applied.\n'));
        }
      } else if (cmd.type === 'skills_reload') {
        skills = await loadSkills(cwd);
        chWrite(chalk.gray('Skills reloaded.\n'));
      }
      continue;
    }

    // @ references
    const { expanded: task, refs } = await resolveAtReferences(raw, cwd);
    if (refs.length > 0) {
      const labels = refs.map((r) => chalk.cyan(r.raw)).join(', ');
      chWrite(chalk.gray(`  Injecting: ${labels}\n`));
    }

    // ── UserPromptSubmit hook ─────────────────────────────────────────
    const hookResult = await getHookRegistry().run({
      event: 'user-prompt-submit',
      prompt: task,
      cwd,
    });
    if (hookResult.action === 'block') {
      chWrite(chalk.yellow(`  [hook blocked prompt: ${hookResult.reason}]\n`));
      continue;
    }
    const effectiveTask = hookResult.action === 'modify' && typeof hookResult.data['prompt'] === 'string'
      ? hookResult.data['prompt']
      : task;

    const interrupt = createInterruptController({ manageStdin: false });
    activeInterrupt = interrupt;
    app.setBusy(true);
    try {
      await runAgentLoop({
        task: effectiveTask, cwd, config, provider, context, skills,
        language: systemLanguage,
        signal: interrupt.signal,
        memorySummary: sessionSummary ?? undefined,
        userPreferences,
        onTurnComplete: (signal) => {
          habitState = observeTurn(signal, habitState);
          const updates = analyzeHabits(habitState);
          if (updates.length > 0) persistHabitUpdates(updates).catch(() => {});
        },
      });
      // Auto-save conversation after each successful turn
      const msgs = context.getMessages();
      if (msgs.filter(m => m.role !== 'system').length > 0) {
        currentSessionId = await saveSession(msgs, {
          id: currentSessionId,
          cwd,
          model: config.model,
        });
      }
      // Record a checkpoint for session branching (v0.7)
      if (currentSessionId) {
        try {
          const tree = await loadBranchTree(currentSessionId);
          const currentId = getCurrentBranchId(tree);
          const branch = tree.branches[currentId];
          const turnIdx = branch?.checkpoints.length ?? 0;
          const nonSysCount = msgs.filter(m => m.role !== 'system').length;
          const updatedTree = recordCheckpoint(tree, turnIdx, nonSysCount, effectiveTask);
          await saveBranchTree(currentSessionId, updatedTree);
        } catch { /* non-critical */ }
      }
    } catch (err) {
      // Clear busy state BEFORE printing anything below — printTypedError()
      // writes directly to stderr (see the comment on printError/
      // printTypedError in display.ts), which bypasses output-channel.ts
      // entirely. That's only safe once the live region is idle; doing it
      // here, ahead of the actual error output, guarantees that ordering.
      // interrupt.cleanup() itself is NOT idempotent (activeCount-- runs
      // unconditionally) — do NOT also call it in `finally` below, or the
      // counter goes negative. app.setBusy(false) IS safe to call twice.
      activeInterrupt = null;
      app.setBusy(false);

      const errName = (err as Error)?.name;
      if (errName === 'AbortError' || errName === 'UserAbortError' || interrupt.signal.aborted) {
        chWrite(chalk.yellow('Interrupted.\n'));
      } else {
        printTypedError(err);
        log.error('Agent loop failed', { error: err instanceof Error ? err.message : String(err) });
        await maybeWriteCrashReport(err, { cwd, task: effectiveTask, model: config.model, crashReportOnError: config.crashReportOnError });
      }
    } finally {
      interrupt.cleanup();
      activeInterrupt = null;
      app.setBusy(false);
      const usage = getSessionUsage();
      app.setTotalTokens(usage.inputTokens + usage.outputTokens);
    }
  }
}
