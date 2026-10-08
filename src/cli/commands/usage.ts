import chalk from 'chalk';
import { getSessionUsage } from '../../core/usage.js';
import { printBalanceAndUsage, formatDualCurrency, PRICING, getTodayUsage, getMonthUsage } from '../../utils/billing.js';
import type { SlashCommand } from './types.js';

function printSessionCost(model: string): void {
  const usage = getSessionUsage();
  const pricing = PRICING[model] ?? PRICING['deepseek-v4-flash'];

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.prompt;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.completion;
  const cacheSavings = (usage.cacheHitTokens / 1_000_000) * (pricing.prompt - pricing.cacheHit);
  const totalCost = inputCost + outputCost - cacheSavings;

  console.log(`
${chalk.bold('Session Usage')}
  ${chalk.gray('Model:')}        ${chalk.cyan(model)}
  ${chalk.gray('Input tokens:')}  ${usage.inputTokens.toLocaleString()}${usage.cacheHitTokens > 0 ? chalk.green(`  (${usage.cacheHitTokens.toLocaleString()} cache hits)`) : ''}
  ${chalk.gray('Output tokens:')} ${usage.outputTokens.toLocaleString()}
  ${chalk.gray('Total tokens:')}  ${(usage.inputTokens + usage.outputTokens).toLocaleString()}
${chalk.gray('─'.repeat(30))}
  ${chalk.gray('Input cost:')}   ${formatDualCurrency(inputCost)}
  ${chalk.gray('Output cost:')}  ${formatDualCurrency(outputCost)}${cacheSavings > 0 ? chalk.green(`\n  ${chalk.gray('Cache saved:')}  -${formatDualCurrency(cacheSavings)}`) : ''}
  ${chalk.bold('Session cost:')} ${formatDualCurrency(totalCost)}
`);
}

function printCacheStats(): void {
  const usage = getSessionUsage();
  const totalInput = usage.inputTokens + usage.cacheHitTokens;
  const hitRate = totalInput > 0 ? (usage.cacheHitTokens / totalInput * 100).toFixed(1) : '0.0';
  const pricing = PRICING['deepseek-v4-flash'] ?? { prompt: 0.14, completion: 0.28, cacheHit: 0.0028 };
  const saved = (usage.cacheHitTokens / 1_000_000) * (pricing.prompt - pricing.cacheHit);

  console.log(`
${chalk.bold('Cache Statistics')}
  ${chalk.gray('Cache hit tokens:')} ${usage.cacheHitTokens.toLocaleString()}
  ${chalk.gray('Cache hit rate:')}   ${chalk.green(hitRate + '%')}
  ${chalk.gray('Cost saved:')}       ${chalk.green(formatDualCurrency(saved))}
`);
}

async function printCostReport(model: string): Promise<void> {
  const [today, month] = await Promise.all([
    getTodayUsage(),
    getMonthUsage(),
  ]);

  const pricing = PRICING[model] ?? PRICING['deepseek-v4-flash'];

  function formatStats(label: string, stats: { inputTokens: number; outputTokens: number; cacheHitTokens: number; cost: number }): string {
    const totalTokens = stats.inputTokens + stats.outputTokens;
    const inputCost = (stats.inputTokens / 1_000_000) * pricing.prompt;
    const outputCost = (stats.outputTokens / 1_000_000) * pricing.completion;
    const cacheSavings = (stats.cacheHitTokens / 1_000_000) * (pricing.prompt - pricing.cacheHit);
    const netCost = inputCost + outputCost - cacheSavings;

    return `${chalk.bold(label)}
  ${chalk.gray('Input tokens:')}   ${stats.inputTokens.toLocaleString()}
  ${chalk.gray('Output tokens:')}  ${stats.outputTokens.toLocaleString()}
  ${chalk.gray('Cache hits:')}     ${stats.cacheHitTokens.toLocaleString()}
  ${chalk.gray('Total tokens:')}   ${totalTokens.toLocaleString()}
  ${chalk.gray('Gross cost:')}     ${formatDualCurrency(inputCost + outputCost)}
  ${chalk.gray('Cache saved:')}    ${chalk.green(formatDualCurrency(cacheSavings))}
  ${chalk.gray('Net cost:')}       ${formatDualCurrency(netCost)}`;
  }

  console.log(`
${chalk.bold('Cost Report')}
  ${chalk.gray('Model:')} ${chalk.cyan(model)}
`);

  console.log(formatStats('📆 Today', today));
  console.log();
  console.log(formatStats('📅 This Month', month));
  console.log();
}

export const usageCommands: SlashCommand[] = [
  {
    name: 'cost',
    desc: 'Show session token usage and cost',
    run({ config }) {
      printSessionCost(config.model);
      return { type: 'handled' };
    },
  },
  {
    name: 'cache',
    desc: 'Show detailed DeepSeek prefix cache performance statistics',
    run() {
      printCacheStats();
      return { type: 'handled' };
    },
  },
  {
    name: 'cost-report',
    desc: 'Show aggregated cost report with per-model breakdown',
    async run({ config }) {
      await printCostReport(config.model);
      return { type: 'handled' };
    },
  },
  {
    name: 'balance',
    desc: 'Show account balance & usage',
    async run({ config }) {
      await printBalanceAndUsage(config.apiKey, config.baseURL, config.model);
      return { type: 'handled' };
    },
  },
];
