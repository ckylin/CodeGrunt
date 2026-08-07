import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchMcpRegistry } from '../../src/core/mcp/registry.js';

describe('searchMcpRegistry', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns an empty array for a blank/whitespace query without calling fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const results = await searchMcpRegistry('   ');
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parses a stdio (npm package) server entry', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{
          server: {
            name: 'io.github.example/filesystem',
            description: 'Filesystem access server',
            packages: [{ registryType: 'npm', identifier: '@example/mcp-filesystem', version: '1.0.0' }],
          },
        }],
      }),
    });

    const results = await searchMcpRegistry('filesystem');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('io.github.example/filesystem');
    expect(results[0].description).toBe('Filesystem access server');
    expect(results[0].install).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', '@example/mcp-filesystem'] });
  });

  it('parses a remote streamable-http server entry, preferring it over a package entry', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{
          server: {
            name: 'ai.smithery/github',
            description: 'GitHub API access',
            packages: [{ registryType: 'npm', identifier: 'should-not-be-used' }],
            remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/@smithery-ai/github/mcp' }],
          },
        }],
      }),
    });

    const results = await searchMcpRegistry('github');
    expect(results[0].install).toEqual({
      kind: 'remote',
      transport: 'streamable-http',
      url: 'https://server.smithery.ai/@smithery-ai/github/mcp',
    });
  });

  it('parses a remote sse server entry when no streamable-http remote exists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{
          server: {
            name: 'example/sse-server',
            description: '',
            remotes: [{ type: 'sse', url: 'https://example.com/sse' }],
          },
        }],
      }),
    });

    const results = await searchMcpRegistry('sse-server');
    expect(results[0].install).toEqual({ kind: 'remote', transport: 'sse', url: 'https://example.com/sse' });
  });

  it('returns install: { kind: "unknown" } when an entry has neither packages nor remotes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{ server: { name: 'example/empty', description: 'nothing installable' } }],
      }),
    });

    const results = await searchMcpRegistry('empty');
    expect(results[0].install).toEqual({ kind: 'unknown' });
  });

  it('skips server entries with no name', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [
          { server: { description: 'missing name' } },
          { server: { name: 'has-name', description: 'ok' } },
        ],
      }),
    });

    const results = await searchMcpRegistry('x');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('has-name');
  });

  it('returns an empty array when the response has no servers field', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const results = await searchMcpRegistry('anything');
    expect(results).toEqual([]);
  });

  it('returns an empty array on a non-ok HTTP status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const results = await searchMcpRegistry('anything');
    expect(results).toEqual([]);
  });

  it('returns an empty array when fetch rejects (network failure)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const results = await searchMcpRegistry('anything');
    expect(results).toEqual([]);
  });

  it('returns an empty array when the response body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });
    const results = await searchMcpRegistry('anything');
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: Array.from({ length: 5 }, (_, i) => ({
          server: { name: `server-${i}`, description: '' },
        })),
      }),
    });
    const results = await searchMcpRegistry('server', 2);
    expect(results).toHaveLength(2);
  });

  it('URL-encodes the query in the request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) });
    global.fetch = fetchSpy as unknown as typeof fetch;
    await searchMcpRegistry('foo bar/baz');
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent('foo bar/baz'));
  });
});
