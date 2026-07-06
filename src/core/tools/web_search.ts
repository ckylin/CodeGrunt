// ── Web Search Tool ───────────────────────────────────────────────────────
// Provides real-time web search capability to the agent.
//
// Supported engines (configurable via CODEGRUNT_SEARCH_ENGINE env var or
// ~/.codegrunt/config.json `searchEngine`):
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

const log = getLogger('tools:web_search');

const DEFAULT_NUM_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

// ── Engine adapters ───────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function searchMojeek(query: string, numResults: number): Promise<SearchResult[]> {
  // Mojeek public search — returns HTML, parse JSON-LD or result blocks
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&fmt=json&num=${numResults}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'CodeGrunt/0.1 (+https://github.com/ckylin/CodeGrunt)' },
  });
  if (!res.ok) throw new Error(`Mojeek returned ${res.status}`);

  // Mojeek has a JSON endpoint for some queries; try to parse
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = await res.json() as { results?: Array<{ title?: string; url?: string; desc?: string }> };
    return (data.results ?? []).slice(0, numResults).map(r => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.desc ?? '',
    }));
  }

  // Fall back to HTML parsing (simple regex extraction)
  const html = await res.text();
  return parseMojeekHtml(html, numResults);
}

function parseMojeekHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Match result blocks: <a class="title" href="...">...</a> ... <p class="s">...</p>
  const blockRe = /<li[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null && results.length < max) {
    const content = block[1];
    const titleMatch = content.match(/<a[^>]*class="[^"]*title[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
    const snippetMatch = content.match(/<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (titleMatch) {
      results.push({
        title: titleMatch[2].trim(),
        url: titleMatch[1],
        snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '',
      });
    }
  }
  return results;
}

async function searchSearXNG(query: string, numResults: number, baseUrl: string): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&num_results=${numResults}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, numResults).map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchDuckDuckGo(query: string, numResults: number): Promise<SearchResult[]> {
  // DuckDuckGo Instant Answers API (no web results) + HTML fallback
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const data = await res.json() as {
    AbstractText?: string;
    AbstractURL?: string;
    AbstractSource?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.AbstractSource ?? 'DuckDuckGo',
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  for (const topic of data.RelatedTopics ?? []) {
    if (results.length >= numResults) break;
    if (topic.FirstURL && topic.Text) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    }
  }
  return results;
}

// ── Engine selector ───────────────────────────────────────────────────────

export function getSearchEngine(): { engine: string; searxngUrl?: string } {
  const engine = process.env['CODEGRUNT_SEARCH_ENGINE'] ?? 'mojeek';
  const searxngUrl = process.env['CODEGRUNT_SEARXNG_URL'];
  return { engine, searxngUrl };
}

async function runSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const { engine, searxngUrl } = getSearchEngine();

  switch (engine) {
    case 'searxng': {
      const url = searxngUrl ?? 'http://localhost:8080';
      return searchSearXNG(query, numResults, url);
    }
    case 'duckduckgo':
      return searchDuckDuckGo(query, numResults);
    case 'mojeek':
    default:
      return searchMojeek(query, numResults);
  }
}

// ── Tool definition ───────────────────────────────────────────────────────

export const webSearchTool: Tool = {
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
