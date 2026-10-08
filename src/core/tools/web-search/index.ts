import { duckduckgoEngine } from './engines/duckduckgo.js';
import { mojeekEngine } from './engines/mojeek.js';
import { searxngEngine } from './engines/searxng.js';
import type { SearchEngine, SearchResult } from './types.js';

export type { SearchEngine, SearchResult, SearchOptions } from './types.js';

const DEFAULT_ENGINE = mojeekEngine;

export const SEARCH_ENGINES: ReadonlyMap<string, SearchEngine> = new Map(
  [mojeekEngine, searxngEngine, duckduckgoEngine].map((e) => [e.id, e]),
);

export function getSearchEngine(): { engine: string; searxngUrl?: string } {
  const engine = process.env['CODEGRUNT_SEARCH_ENGINE'] ?? 'mojeek';
  const searxngUrl = process.env['CODEGRUNT_SEARXNG_URL'];
  return { engine, searxngUrl };
}

/** Runs the configured engine; an unknown or empty engine name falls back to mojeek. */
export async function runSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const { engine, searxngUrl } = getSearchEngine();
  return (SEARCH_ENGINES.get(engine) ?? DEFAULT_ENGINE).search(query, numResults, { searxngUrl });
}
