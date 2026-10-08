import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { CodeGruntConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.codegrunt');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS: CodeGruntConfig = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  maxTokens: 8192,
  temperature: 0.2,
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  reasoningEffort: 'medium',
  autoThinkingMode: true,
  autoCompact: true,
  crashReportOnError: false,
  theme: 'dark',
};

async function loadConfigFile(): Promise<Partial<CodeGruntConfig>> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Partial<CodeGruntConfig>;
  } catch {
    return {};
  }
}

/** Parse an integer env var, returning the fallback if the value is missing or NaN. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

/** Parse a float env var, returning the fallback if the value is missing or NaN. */
function envFloat(name: string, fallback: number): number;
function envFloat(name: string, fallback: number | undefined): number | undefined;
function envFloat(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return isNaN(n) ? fallback : n;
}

/** Parse a boolean env var ('1'/'true' → true, '0'/'false' → false), returning the fallback otherwise. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

export async function loadConfig(): Promise<CodeGruntConfig> {
  const fileConfig = await loadConfigFile();

  return {
    provider: process.env.CODEGRUNT_PROVIDER ?? fileConfig.provider ?? DEFAULTS.provider,
    model: process.env.CODEGRUNT_MODEL ?? fileConfig.model ?? DEFAULTS.model,
    maxTokens: envInt('CODEGRUNT_MAX_TOKENS', fileConfig.maxTokens ?? DEFAULTS.maxTokens),
    temperature: envFloat('CODEGRUNT_TEMPERATURE', fileConfig.temperature ?? DEFAULTS.temperature),
    apiKey: process.env.DEEPSEEK_API_KEY ?? fileConfig.apiKey ?? '',
    baseURL: process.env.CODEGRUNT_BASE_URL ?? fileConfig.baseURL ?? DEFAULTS.baseURL,
    reasoningEffort: (process.env.CODEGRUNT_REASONING_EFFORT as 'low' | 'medium' | 'high')
      ?? fileConfig.reasoningEffort
      ?? DEFAULTS.reasoningEffort,
    topP: envFloat('CODEGRUNT_TOP_P', fileConfig.topP ?? DEFAULTS.topP),
    frequencyPenalty: envFloat('CODEGRUNT_FREQUENCY_PENALTY', fileConfig.frequencyPenalty ?? DEFAULTS.frequencyPenalty),
    presencePenalty: envFloat('CODEGRUNT_PRESENCE_PENALTY', fileConfig.presencePenalty ?? DEFAULTS.presencePenalty),
    trustMode: (process.env.CODEGRUNT_TRUST_MODE as 'plan' | 'code' | 'auto')
      ?? fileConfig.trustMode
      ?? 'code',
    searchEngine: (process.env.CODEGRUNT_SEARCH_ENGINE as 'mojeek' | 'searxng' | 'duckduckgo')
      ?? fileConfig.searchEngine
      ?? 'mojeek',
    searxngUrl: process.env.CODEGRUNT_SEARXNG_URL ?? fileConfig.searxngUrl,
    autoThinkingMode: envBool("CODEGRUNT_AUTO_THINKING", fileConfig.autoThinkingMode ?? true),
    autoCompact: envBool("CODEGRUNT_AUTO_COMPACT", fileConfig.autoCompact ?? true),
    crashReportOnError: envBool("CODEGRUNT_CRASH_REPORT", fileConfig.crashReportOnError ?? false),
    theme: (process.env.CODEGRUNT_THEME as 'dark' | 'light') ?? fileConfig.theme ?? 'dark',
  };
}

export async function saveConfig(config: CodeGruntConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(
      {
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        topP: config.topP,
        frequencyPenalty: config.frequencyPenalty,
        presencePenalty: config.presencePenalty,
        trustMode: config.trustMode,
        searchEngine: config.searchEngine,
        searxngUrl: config.searxngUrl,
        autoThinkingMode: config.autoThinkingMode,
        autoCompact: config.autoCompact,
        crashReportOnError: config.crashReportOnError,
        theme: config.theme,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

export { isReasonerModel, supportsReasoning } from './providers/model-policy.js';

/**
 * Both DeepSeek V4 Pro/Flash and R1 reasoner models now ship a 1M-token
 * context window (raised from the older 128K-class models this budget was
 * originally sized for). These budgets are deliberately kept far below that
 * ceiling: growing conversation history toward 1M tokens multiplies the
 * cache-miss cost on every turn that doesn't hit DeepSeek's disk-based
 * prefix cache ($0.14/M miss vs $0.014/M hit — see ContextManager's
 * cache-preservation comments), and bloats per-turn latency. Treat these as
 * a cost/latency budget, not the model's actual context ceiling.
 */
export const CONTEXT_BUDGET = 100_000;

/** Chat-tier model budget — same rationale as CONTEXT_BUDGET above. */
export const CHAT_CONTEXT_BUDGET = 90_000;
