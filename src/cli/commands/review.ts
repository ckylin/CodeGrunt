import chalk from 'chalk';
import type { LLMProvider, Message, CodeGruntConfig } from '../../types.js';
import type { ContextManager } from '../../core/context/manager.js';
import { MarkdownRenderer } from '../../utils/markdown.js';
import type { SlashCommand } from './types.js';

async function reviewContext(
  context: ContextManager,
  config: CodeGruntConfig,
  provider: LLMProvider,
): Promise<void> {
  const messages = context.getMessages();
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (nonSystem.length < 2) {
    console.log(chalk.gray('No conversation to review yet.'));
    return;
  }

  console.log(chalk.bold('\n🔍 Reviewing session changes for logic issues…\n'));

  const reviewPrompt = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      if ('tool_calls' in m && m.tool_calls) {
        const calls = m.tool_calls.map(tc =>
          `  → ${tc.function.name}(${tc.function.arguments})`
        ).join('\n');
        return `${role}: [tool calls]\n${calls}`;
      }
      const content = 'content' in m && m.content ? String(m.content) : '';
      return `${role}: ${content}`;
    })
    .join('\n\n');

  const reviewMessages: Message[] = [
    {
      role: 'system',
      content: `You are an expert code reviewer. Analyze the following conversation log containing code changes (write_file, edit_file tool calls). Focus on:
- Logical errors or inconsistencies in the code changes
- Potential bugs, edge cases, or race conditions
- Missing error handling
- Type safety issues
- Breaking changes to existing APIs or interfaces
- Performance concerns

Provide a structured review:
1. **Critical Issues** — bugs that would cause runtime errors or data loss
2. **Logic Issues** — flaws in reasoning, incorrect assumptions, edge cases missed
3. **Style / Best Practices** — deviations from conventions, minor improvements
4. **Summary** — overall assessment

If no issues are found, clearly state that the changes look correct. Be specific — reference exact file paths and line content from the conversation.`,
    },
    {
      role: 'user',
      content: `Review this conversation session for logic issues:\n\n${reviewPrompt}`,
    },
  ];

  // Spinner animation while waiting for the first token
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${spinnerChars[spinnerIdx]} Analyzing…`));
    spinnerIdx = (spinnerIdx + 1) % spinnerChars.length;
  }, 80);

  let review = '';
  const md = new MarkdownRenderer();
  try {
    const stream = provider.stream(reviewMessages, {
      model: config.model,
      maxTokens: 4096,
      temperature: 0.2,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        if (!review) {
          clearInterval(spinnerInterval);
          process.stdout.write('\r' + ' '.repeat(20) + '\r');
        }
        review += chunk.text;
        const formatted = md.feed(chunk.text);
        if (formatted) process.stdout.write(formatted);
      }
    }
    // Flush any remaining markdown buffer (e.g. pending table)
    const flushOut = md.flush();
    if (flushOut) process.stdout.write(flushOut);
  } catch (err) {
    clearInterval(spinnerInterval);
    process.stdout.write('\r' + ' '.repeat(20) + '\r');
    console.log(chalk.red('\nFailed to review: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  console.log('\n');
}

export const reviewCommands: SlashCommand[] = [
  {
    name: 'review',
    desc: 'Review session changes for logic issues',
    async run({ context, config, provider }) {
      await reviewContext(context, config, provider);
      return { type: 'handled' };
    },
  },
];
