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
      },
      null,
      2,
    ),
    'utf-8',
  );
}

/**
 * Detect whether the current model is a DeepSeek "pure" reasoner (R1) model.
 * R1 models do NOT support `temperature`, reject the `system` role, and
 * require the system prompt to be embedded in the first user message.
 */
export function isReasonerModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('reasoner') || lower.includes('r1');
}

/**
 * Detect whether the model supports reasoning/thinking capabilities
 * (emits reasoning_content, supports reasoning_effort parameter).
 * This includes R1 reasoner models AND V4 Pro models.
 */
export function supportsReasoning(model: string): boolean {
  const lower = model.toLowerCase();
  return isReasonerModel(model)
    || lower.includes('v4')
    || lower.includes('pro');
}

/** Reasoner models have a huge context (1M tokens) — give them more room */
export const CONTEXT_BUDGET = 100_000;

/** Chat model context window is 128K — budget for conversation history */
export const CHAT_CONTEXT_BUDGET = 90_000;
