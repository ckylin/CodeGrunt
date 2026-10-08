import { fetchWithTimeout } from '../http.js';
import type { SearchEngine, SearchResult } from '../types.js';

export const duckduckgoEngine: SearchEngine = {
  id: 'duckduckgo',

  async search(query, numResults) {
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
  },
};
