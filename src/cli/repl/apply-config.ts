import { supportsReasoning, CONTEXT_BUDGET, CHAT_CONTEXT_BUDGET } from '../../config.js';
import { applyTheme } from '../../utils/constants.js';
import type { CodeGruntConfig } from '../../types.js';

/** Context token budget for the configured model: reasoning models get the larger one. */
export function contextBudgetFor(config: Pick<CodeGruntConfig, 'model'>): number {
  return supportsReasoning(config.model) ? CONTEXT_BUDGET : CHAT_CONTEXT_BUDGET;
}

/**
 * Push the parts of a config that other modules read from ambient state:
 * the TUI theme, and the web-search settings that tools read from env vars
 * (so they need no dependency injection).
 */
export function applyConfig(config: CodeGruntConfig): void {
  applyTheme(config.theme ?? 'dark');
  if (config.searchEngine) process.env['CODEGRUNT_SEARCH_ENGINE'] = config.searchEngine;
  if (config.searxngUrl) process.env['CODEGRUNT_SEARXNG_URL'] = config.searxngUrl;
}
