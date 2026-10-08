import { fetchWithTimeout } from '../http.js';
import type { SearchEngine } from '../types.js';

const DEFAULT_SEARXNG_URL = 'http://localhost:8080';

export const searxngEngine: SearchEngine = {
  id: 'searxng',

  async search(query, numResults, opts) {
    const baseUrl = opts.searxngUrl ?? DEFAULT_SEARXNG_URL;

    // searxngUrl comes from config/env, not from the LLM directly, but it's
    // still user-supplied and unvalidated at the point it's set (config.ts,
    // /search-engine). Validate here — the actual network boundary — so a
    // malformed value fails clearly instead of producing a confusing fetch
    // error, and non-http(s) schemes (file:, gopher:, etc.) can't be used.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid searxngUrl: "${baseUrl}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`searxngUrl must use http or https, got: ${parsed.protocol}`);
    }

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
  },
};
