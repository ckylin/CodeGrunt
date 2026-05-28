import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const CONFIG_DIR = join(homedir(), '.codegrunt');
const USAGE_PATH = join(CONFIG_DIR, 'usage.json');

// ── DeepSeek balance API response ─────────────────────────────────────────

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

// ── Local usage record ────────────────────────────────────────────────────

export interface DailyUsage {
  [date: string]: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cost: number;
  };
}

interface UsageRecord {
  [month: string]: DailyUsage;
}

// ── Fetch balance from DeepSeek API ───────────────────────────────────────

export async function fetchBalance(apiKey: string, baseURL: string): Promise<BalanceResponse> {
  const url = `${baseURL}/user/balance`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Balance API returned ${resp.status}: ${body || resp.statusText}`);
  }

  return (await resp.json()) as BalanceResponse;
}

// ── Local usage persistence ───────────────────────────────────────────────

async function loadUsageFile(): Promise<UsageRecord> {
  try {
    const raw = await readFile(USAGE_PATH, 'utf-8');
    return JSON.parse(raw) as UsageRecord;
  } catch {
    return {};
  }
}

async function saveUsageFile(record: UsageRecord): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(USAGE_PATH, JSON.stringify(record, null, 2), 'utf-8');
}

/** Record a completed API call to local usage log */
export async function recordUsage(inputTokens: number, outputTokens: number, cacheHitTokens: number, cost: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const month = today.slice(0, 7); // YYYY-MM

  const record = await loadUsageFile();
  if (!record[month]) record[month] = {};
  if (!record[month][today]) {
    record[month][today] = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cost: 0 };
  }

  record[month][today].inputTokens += inputTokens;
  record[month][today].outputTokens += outputTokens;
  record[month][today].cacheHitTokens += cacheHitTokens;
  record[month][today].cost += cost;

  // Clean up old months (keep only last 6)
  const months = Object.keys(record).sort();
  while (months.length > 6) {
    delete record[months.shift()!];
  }

  await saveUsageFile(record);
}

// ── Exchange rate: USD → CNY ( RMB ) ─────────────────────────────────────
export const USD_TO_CNY = 7.25;

export function formatDualCurrency(usdAmount: number): string {
  const cnyAmount = usdAmount * USD_TO_CNY;
  return `${chalk.yellow(`${usdAmount.toFixed(4)}`)} ${chalk.gray(`(¥${cnyAmount.toFixed(2)} RMB)`)}`;
}

// ── DEEPSEEK pricing (USD per 1M tokens) ──────────────────────────────────

export const PRICING: Record<string, { prompt: number; completion: number; cacheHit: number }> = {
  'deepseek-chat':     { prompt: 0.27, completion: 1.10, cacheHit: 0.07 },
  'deepseek-v4-flash': { prompt: 0.27, completion: 1.10, cacheHit: 0.07 },
  'deepseek-v4-pro':   { prompt: 0.27, completion: 1.10, cacheHit: 0.07 },
  'deepseek-reasoner': { prompt: 0.55, completion: 2.19, cacheHit: 0.14 },
};

// ── Query helpers ─────────────────────────────────────────────────────────

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cost: number;
}

function zeroStats(): UsageStats {
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cost: 0 };
}

/** Get today's usage summary */
export async function getTodayUsage(): Promise<UsageStats> {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const record = await loadUsageFile();
  const dayData = record[month]?.[today];
  if (!dayData) return zeroStats();
  return { ...dayData };
}

/** Get this month's usage summary */
export async function getMonthUsage(): Promise<UsageStats> {
  const month = new Date().toISOString().slice(0, 7);
  const record = await loadUsageFile();
  const monthData = record[month];
  if (!monthData) return zeroStats();

  const result = zeroStats();
  for (const day of Object.values(monthData)) {
    result.inputTokens += day.inputTokens;
    result.outputTokens += day.outputTokens;
    result.cacheHitTokens += day.cacheHitTokens;
    result.cost += day.cost;
  }
  return result;
}

// ── Spinner helpers ───────────────────────────────────────────────────────

function startSpinner(text: string): ReturnType<typeof setInterval> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  process.stdout.write('\r' + chalk.gray(`${frames[0]} ${text}`));
  const interval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${frames[idx]} ${text}`));
    idx = (idx + 1) % frames.length;
  }, 80);
  return interval;
}

function stopSpinner(interval: ReturnType<typeof setInterval>): void {
  clearInterval(interval);
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
}

// ── Display ───────────────────────────────────────────────────────────────

export async function printBalanceAndUsage(apiKey: string, baseURL: string, model: string): Promise<void> {
  // Spinner while fetching balance (network call to DeepSeek API)
  const spinner = startSpinner('Fetching balance & usage…');

  // Fetch balance in parallel with reading local usage
  const [balanceResult, todayUsage, monthUsage] = await Promise.allSettled([
    fetchBalance(apiKey, baseURL),
    getTodayUsage(),
    getMonthUsage(),
  ]);

  stopSpinner(spinner);

  console.log();

  // ── Balance ─────────────────────────────────────────────────────────
  if (balanceResult.status === 'fulfilled') {
    const balance = balanceResult.value;
    if (balance.is_available && balance.balance_infos.length > 0) {
      console.log(chalk.bold('💰 Account Balance'));
      for (const info of balance.balance_infos) {
        console.log(`  ${chalk.gray('Total:')}        ${chalk.green(info.total_balance)} ${info.currency}`);
        if (info.granted_balance && info.granted_balance !== '0.00') {
          console.log(`  ${chalk.gray('Granted:')}      ${chalk.cyan(info.granted_balance)} ${info.currency}`);
        }
        if (info.topped_up_balance && info.topped_up_balance !== '0.00') {
          console.log(`  ${chalk.gray('Topped Up:')}    ${chalk.cyan(info.topped_up_balance)} ${info.currency}`);
        }
      }
      console.log();
    } else {
      console.log(chalk.gray('Balance info not available.\n'));
    }
  } else {
    console.log(chalk.yellow(`Balance: Failed to fetch — ${balanceResult.reason}\n`));
  }

  // ── Today's usage ───────────────────────────────────────────────────
  console.log(formatUsageSection('📆 Today\'s Usage', todayUsage));

  // ── This month's usage ──────────────────────────────────────────────
  console.log(formatUsageSection('📅 This Month\'s Usage', monthUsage));
}

function formatUsageSection(title: string, result: PromiseSettledResult<UsageStats>): string {
  const lines: string[] = [chalk.bold(title)];

  if (result.status === 'rejected') {
    lines.push(chalk.gray(`  (not available)`));
    return lines.join('\n') + '\n';
  }

  const stats = result.value;
  if (stats.inputTokens === 0 && stats.outputTokens === 0) {
    lines.push(chalk.gray(`  0 tokens · $0.0000 (¥0.00 RMB)`));
    return lines.join('\n') + '\n';
  }

  const totalTokens = stats.inputTokens + stats.outputTokens;
  lines.push(`  ${chalk.gray('Input:')}       ${formatNumber(stats.inputTokens)} tokens`);
  lines.push(`  ${chalk.gray('Output:')}      ${formatNumber(stats.outputTokens)} tokens`);
  if (stats.cacheHitTokens > 0) {
    lines.push(`  ${chalk.gray('Cache hits:')}  ${formatNumber(stats.cacheHitTokens)} tokens`);
  }
  lines.push(`  ${chalk.gray('Total tokens:')} ${formatNumber(totalTokens)} tokens`);
  lines.push(`  ${chalk.gray('Cost:')}         ${formatDualCurrency(stats.cost)}`);

  return lines.join('\n') + '\n';
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}
