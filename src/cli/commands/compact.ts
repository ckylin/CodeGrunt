import chalk from 'chalk';
import type { LLMProvider, Message, CodeGruntConfig } from '../../types.js';
import type { ContextManager } from '../../core/context/manager.js';
import { isReasonerModel } from '../../config.js';
import { saveSessionSummary } from '../../core/memory/store.js';
import type { SlashCommand } from './types.js';

async function compactContext(
  context: ContextManager,
  config: CodeGruntConfig,
  provider: LLMProvider,
  cwd: string,
): Promise<void> {
  const messages = context.getMessages();
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (nonSystem.length < 4) {
    console.log(chalk.gray('Context is already short, nothing to compact.'));
    return;
  }

  const beforeMessages = messages.length;
  const beforeTokens = context.estimatedTokenCount();

  // Spinner while waiting for LLM
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${spinnerChars[spinnerIdx]} Compacting context…`));
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  const reasoner = isReasonerModel(config.model);
  const instruction = 'You are a helpful assistant. Summarize the following conversation concisely, preserving key decisions, code changes made, and any important context needed to continue the work. Output only the summary.';
  const conversationText = nonSystem
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = 'content' in m && m.content ? String(m.content) : '[tool call]';
      return `${role}: ${content}`;
    })
    .join('\n\n');

  // R1 reasoner models reject the system role — embed instruction in user message
  const summaryMessages: Message[] = reasoner
    ? [{ role: 'user', content: `[System Instructions]\n${instruction}\n\n---\n\n${conversationText}` }]
    : [
        { role: 'system', content: instruction },
        { role: 'user', content: conversationText },
      ];

  let summary = '';
  try {
    const stream = provider.stream(summaryMessages, {
      model: config.model,
      maxTokens: 1024,
      ...(reasoner ? {} : { temperature: 0.2 }),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') summary += chunk.text;
    }
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    console.log(chalk.red('Failed to compact: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (!summary.trim()) {
    console.log(chalk.yellow('Compact aborted: model returned empty summary. Context unchanged.'));
    return;
  }

  context.compact(summary.trim());
  saveSessionSummary(cwd, summary.trim()).catch(() => {});

  const afterMessages = context.getMessages().length;
  const afterTokens = context.estimatedTokenCount();
  console.log(
    chalk.green('✓ Context compacted') +
    chalk.gray(`  ${beforeMessages} → ${afterMessages} messages  (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)`),
  );
}

export const compactCommands: SlashCommand[] = [
  {
    name: 'compact',
    desc: 'Summarize and compress conversation history to save tokens',
    async run({ context, config, provider, cwd }) {
      await compactContext(context, config, provider, cwd);
      return { type: 'handled' };
    },
  },
];
