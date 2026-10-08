// ── Web Search Tool ───────────────────────────────────────────────────────
// Provides real-time web search capability to the agent.
//
// Supported engines (configurable via CODEGRUNT_SEARCH_ENGINE env var or
// ~/.codegrunt/config.json `searchEngine`), each a SearchEngine in
// ./web-search/engines/:
//
//   mojeek    — default. Privacy-respecting, no API key required.
//               Uses Mojeek's public search endpoint.
//   searxng   — self-hosted SearXNG instance. Set CODEGRUNT_SEARXNG_URL
//               or config `searxngUrl` to your instance URL.
//   duckduckgo — DuckDuckGo HTML endpoint (no key required, rate-limited).
//
// Result format: ranked list of { title, url, snippet }

import type { Tool, ToolResult } from '../../types.js';
import { getLogger } from '../observability/logger.js';
import { getSearchEngine, runSearch } from './web-search/index.js';

export { getSearchEngine };

const log = getLogger('tools:web_search');

const DEFAULT_NUM_RESULTS = 5;

export const webSearchTool: Tool = {
  meta: { subagentSafe: true },
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, documentation, package versions, error messages, or any topic not in your training data. Returns a ranked list of results with title, URL, and snippet.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific — include error messages verbatim, package names, or version numbers.',
          },
          num_results: {
            type: 'number',
            description: `Number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: 10)`,
          },
        },
        required: ['query'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const query = args['query'] as string;
    const numResults = Math.min(10, Math.max(1, (args['num_results'] as number | undefined) ?? DEFAULT_NUM_RESULTS));

    log.info('Web search', { query, numResults, engine: getSearchEngine().engine });

    try {
      const results = await runSearch(query, numResults);

      if (results.length === 0) {
        return { success: true, output: `No results found for: ${query}` };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return {
        success: true,
        output: `Search results for: "${query}" (${getSearchEngine().engine})\n\n${formatted}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Web search failed', { query, error: msg });
      return { success: false, output: '', error: `Web search failed: ${msg}` };
    }
  },
};
