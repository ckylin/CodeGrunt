import { fetchWithTimeout } from '../http.js';
import type { SearchEngine, SearchResult } from '../types.js';

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

export const mojeekEngine: SearchEngine = {
  id: 'mojeek',

  async search(query, numResults) {
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
  },
};
