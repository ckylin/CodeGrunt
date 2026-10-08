export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  /** Base URL of a self-hosted SearXNG instance (from env/config). */
  searxngUrl?: string;
}

/** One web search backend. Engines are registered by `id` in the engine map. */
export interface SearchEngine {
  readonly id: string;
  search(query: string, numResults: number, opts: SearchOptions): Promise<SearchResult[]>;
}
