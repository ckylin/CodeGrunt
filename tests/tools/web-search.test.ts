import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHome, type FakeHome } from '../helpers/fake-home.js';

type Mod = typeof import('../../src/core/tools/web-search.js');

let fake: FakeHome;
let ws: Mod;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

beforeEach(async () => {
  fake = await createFakeHome();
  vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', '');
  vi.stubEnv('CODEGRUNT_SEARXNG_URL', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  ws = await import('../../src/core/tools/web-search.js');
});

afterEach(async () => {
  await fake.cleanup();
});

const search = (query: string, extra: Record<string, unknown> = {}) => ws.webSearchTool.execute({ query, ...extra });
const calledUrl = (): string => String(fetchMock.mock.calls[0][0]);

describe('getSearchEngine', () => {
  it('defaults to mojeek when the env var is unset', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('CODEGRUNT_LOG_FILE', '0');
    delete process.env.CODEGRUNT_SEARCH_ENGINE;
    expect(ws.getSearchEngine().engine).toBe('mojeek');
  });

  it('an empty env var is not defaulted (?? only handles undefined), and then routes to mojeek via the switch default', async () => {
    expect(ws.getSearchEngine().engine).toBe('');
    fetchMock.mockResolvedValue(json({ results: [] }));
    await search('q');
    expect(calledUrl()).toContain('mojeek.com');
  });

  it('reads engine and searxng url from env', () => {
    vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'searxng');
    vi.stubEnv('CODEGRUNT_SEARXNG_URL', 'http://x:1');
    expect(ws.getSearchEngine()).toEqual({ engine: 'searxng', searxngUrl: 'http://x:1' });
  });
});

describe('mojeek', () => {
  beforeEach(() => vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'mojeek'));

  it('requests the encoded query with num and a User-Agent', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    await search('a b&c', { num_results: 3 });
    expect(calledUrl()).toBe('https://www.mojeek.com/search?q=a%20b%26c&fmt=json&num=3');
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/^CodeGrunt/);
  });

  it('formats JSON results as a numbered list', async () => {
    fetchMock.mockResolvedValue(json({ results: [
      { title: 'One', url: 'https://one', desc: 'first' },
      { title: 'Two', url: 'https://two', desc: 'second' },
    ] }));
    const r = await search('thing');
    expect(r.success).toBe(true);
    expect(r.output).toBe(
      'Search results for: "thing" (mojeek)\n\n1. **One**\n   URL: https://one\n   first\n\n2. **Two**\n   URL: https://two\n   second',
    );
  });

  it('parses HTML result blocks when the response is not JSON', async () => {
    fetchMock.mockResolvedValue(html(`
      <ul>
        <li class="result"><a class="title" href="https://a.example">Alpha</a><p class="s">snippet <b>A</b></p></li>
        <li class="result"><a class="title" href="https://b.example">Beta</a></li>
        <li class="other"><a class="title" href="https://c.example">Ignored</a></li>
      </ul>`));
    const r = await search('x');
    expect(r.output).toContain('1. **Alpha**\n   URL: https://a.example\n   snippet A');
    expect(r.output).toContain('2. **Beta**\n   URL: https://b.example');
    expect(r.output).not.toContain('Ignored');
  });

  it('HTML parsing stops at the requested number of results', async () => {
    const items = [1, 2, 3].map(i => `<li class="result"><a class="title" href="https://${i}">T${i}</a></li>`).join('');
    fetchMock.mockResolvedValue(html(items));
    const r = await search('x', { num_results: 2 });
    expect(r.output).toContain('T1');
    expect(r.output).toContain('T2');
    expect(r.output).not.toContain('T3');
  });

  it('reports "No results" for an empty result set', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    expect(await search('nothing')).toEqual({ success: true, output: 'No results found for: nothing' });
  });

  it('fills missing JSON fields with empty strings', async () => {
    fetchMock.mockResolvedValue(json({ results: [{}] }));
    expect((await search('q')).output).toContain('1. ****\n   URL: \n   ');
  });

  it('a non-ok response becomes a failed ToolResult', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    const r = await search('q');
    expect(r).toEqual({ success: false, output: '', error: 'Web search failed: Mojeek returned 503' });
  });

  it('a rejected fetch becomes a failed ToolResult', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const r = await search('q');
    expect(r.success).toBe(false);
    expect(r.error).toBe('Web search failed: network down');
  });

  it('an unknown engine name falls through to mojeek', async () => {
    vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'altavista');
    fetchMock.mockResolvedValue(json({ results: [] }));
    const r = await search('q');
    expect(calledUrl()).toContain('mojeek.com');
    expect(r.output).toBe('No results found for: q');
  });
});

describe('num_results clamping', () => {
  beforeEach(() => vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'mojeek'));

  it.each([
    [undefined, 5],
    [50, 10],
    [-3, 1],
    [0, 1],
    [4, 4],
  ])('num_results=%s -> num=%s', async (given, expected) => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    await search('q', given === undefined ? {} : { num_results: given });
    expect(calledUrl()).toContain(`num=${expected}`);
  });
});

describe('searxng', () => {
  beforeEach(() => vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'searxng'));

  it('uses http://localhost:8080 when no url is configured (empty env var is not defaulted by ??)', async () => {
    // CODEGRUNT_SEARXNG_URL is '' here, so `searxngUrl ?? default` keeps ''.
    fetchMock.mockResolvedValue(json({ results: [] }));
    const r = await search('q');
    expect(r.success).toBe(false);
    expect(r.error).toBe('Web search failed: Invalid searxngUrl: ""');
  });

  it('defaults to localhost:8080 only when the env var is truly unset', async () => {
    delete process.env.CODEGRUNT_SEARXNG_URL;
    fetchMock.mockResolvedValue(json({ results: [] }));
    await search('q');
    expect(calledUrl()).toBe('http://localhost:8080/search?q=q&format=json&num_results=5');
  });

  it('strips one trailing slash and maps content -> snippet', async () => {
    vi.stubEnv('CODEGRUNT_SEARXNG_URL', 'https://searx.example/');
    fetchMock.mockResolvedValue(json({ results: [{ title: 'T', url: 'https://u', content: 'body' }] }));
    const r = await search('hello world', { num_results: 2 });
    expect(calledUrl()).toBe('https://searx.example/search?q=hello%20world&format=json&num_results=2');
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe('application/json');
    expect(r.output).toContain('1. **T**\n   URL: https://u\n   body');
  });

  it('rejects a malformed url without calling fetch', async () => {
    vi.stubEnv('CODEGRUNT_SEARXNG_URL', 'not a url');
    const r = await search('q');
    expect(r.error).toBe('Web search failed: Invalid searxngUrl: "not a url"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/passwd', 'ftp://host/x', 'gopher://h'])('rejects non-http(s) scheme %s', async (url) => {
    vi.stubEnv('CODEGRUNT_SEARXNG_URL', url);
    const r = await search('q');
    expect(r.error).toMatch(/^Web search failed: searxngUrl must use http or https, got: /);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-ok response is reported with the SearXNG label', async () => {
    vi.stubEnv('CODEGRUNT_SEARXNG_URL', 'http://s');
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    expect((await search('q')).error).toBe('Web search failed: SearXNG returned 500');
  });
});

describe('duckduckgo', () => {
  beforeEach(() => vi.stubEnv('CODEGRUNT_SEARCH_ENGINE', 'duckduckgo'));

  it('queries the instant-answer API', async () => {
    fetchMock.mockResolvedValue(json({}));
    await search('rust lang');
    expect(calledUrl()).toBe('https://api.duckduckgo.com/?q=rust%20lang&format=json&no_html=1&skip_disambig=1');
  });

  it('lists the abstract first, then related topics', async () => {
    fetchMock.mockResolvedValue(json({
      AbstractText: 'about it', AbstractURL: 'https://wiki', AbstractSource: 'Wikipedia',
      RelatedTopics: [{ Text: 'related one', FirstURL: 'https://r1' }, { Text: 'no url' }],
    }));
    const r = await search('q');
    expect(r.output).toContain('1. **Wikipedia**\n   URL: https://wiki\n   about it');
    expect(r.output).toContain('2. **related one**\n   URL: https://r1\n   related one');
    expect(r.output).not.toContain('no url');
  });

  it('titles default to "DuckDuckGo" and related titles are cut at 80 chars', async () => {
    const long = 'x'.repeat(100);
    fetchMock.mockResolvedValue(json({
      AbstractText: 't', AbstractURL: 'https://a',
      RelatedTopics: [{ Text: long, FirstURL: 'https://r' }],
    }));
    const r = await search('q');
    expect(r.output).toContain('**DuckDuckGo**');
    expect(r.output).toContain(`**${'x'.repeat(80)}**`);
  });

  it('the abstract counts toward num_results, but is never dropped by it', async () => {
    fetchMock.mockResolvedValue(json({
      AbstractText: 'a', AbstractURL: 'https://a',
      RelatedTopics: [1, 2, 3].map(i => ({ Text: `t${i}`, FirstURL: `https://${i}` })),
    }));
    const r = await search('q', { num_results: 2 });
    expect(r.output).toContain('2. **t1**');
    expect(r.output).not.toContain('t2');
  });

  it('reports no results when the API returns nothing usable', async () => {
    fetchMock.mockResolvedValue(json({ AbstractText: 'no url so ignored' }));
    expect((await search('q')).output).toBe('No results found for: q');
  });

  it('a non-ok response is reported with the DuckDuckGo label', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));
    expect((await search('q')).error).toBe('Web search failed: DuckDuckGo returned 429');
  });
});
