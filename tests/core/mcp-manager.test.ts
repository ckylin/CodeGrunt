import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '../../src/core/mcp/types.js';

// ── Mock the MCP SDK ─────────────────────────────────────────────────────────
// We don't want real network/process connections in unit tests — mock the
// Client and all three transport classes, and track which transport class
// was instantiated for each connect() call so we can assert manager.ts picks
// the right one per config.transport.

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

class FakeTransport {
  kind: string;
  url?: URL;
  opts?: unknown;
  constructor(kind: string, urlOrOpts?: URL | unknown) {
    this.kind = kind;
    if (urlOrOpts instanceof URL) this.url = urlOrOpts;
    else this.opts = urlOrOpts;
  }
  close = vi.fn().mockResolvedValue(undefined);
}

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => new FakeTransport('stdio', opts)),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation((url: URL) => new FakeTransport('sse', url)),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL) => new FakeTransport('streamable-http', url)),
}));

// Import AFTER the mocks are registered.
const { McpClientManager } = await import('../../src/core/mcp/manager.js');
const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
const sseMod = await import('@modelcontextprotocol/sdk/client/sse.js');
const httpMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

describe('McpClientManager — transport selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
  });

  it('instantiates StdioClientTransport for transport: "stdio"', async () => {
    const manager = new McpClientManager();
    const config: McpServerConfig = { name: 'srv-a', transport: 'stdio', command: 'npx', args: ['-y', 'foo'] };
    await manager.connect(config);
    expect(stdioMod.StdioClientTransport).toHaveBeenCalledWith({ command: 'npx', args: ['-y', 'foo'], env: undefined });
  });

  it('instantiates SSEClientTransport for transport: "sse"', async () => {
    const manager = new McpClientManager();
    const config: McpServerConfig = { name: 'srv-b', transport: 'sse', url: 'http://localhost:9000/sse' };
    await manager.connect(config);
    expect(sseMod.SSEClientTransport).toHaveBeenCalled();
    const calledUrl = (sseMod.SSEClientTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe('http://localhost:9000/sse');
  });

  it('instantiates StreamableHTTPClientTransport for transport: "streamable-http"', async () => {
    const manager = new McpClientManager();
    const config: McpServerConfig = { name: 'srv-c', transport: 'streamable-http', url: 'https://example.com/mcp' };
    await manager.connect(config);
    expect(httpMod.StreamableHTTPClientTransport).toHaveBeenCalled();
    const calledUrl = (httpMod.StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe('https://example.com/mcp');
  });

  it('throws when a stdio config is missing a command', async () => {
    const manager = new McpClientManager();
    const config = { name: 'srv-d', transport: 'stdio' } as McpServerConfig;
    await expect(manager.connect(config)).rejects.toThrow(/requires a command/);
  });

  it('throws when an sse config is missing a url', async () => {
    const manager = new McpClientManager();
    const config = { name: 'srv-e', transport: 'sse' } as McpServerConfig;
    await expect(manager.connect(config)).rejects.toThrow(/requires a url/);
  });

  it('throws when a streamable-http config is missing a url', async () => {
    const manager = new McpClientManager();
    const config = { name: 'srv-f', transport: 'streamable-http' } as McpServerConfig;
    await expect(manager.connect(config)).rejects.toThrow(/requires a url/);
  });

  it('registers connected state and tool names on success', async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: 'do_thing', description: 'does a thing' }] });
    const manager = new McpClientManager();
    const config: McpServerConfig = { name: 'srv-g', transport: 'streamable-http', url: 'https://example.com/mcp' };
    const tools = await manager.connect(config);
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.function.name).toBe('mcp_srv-g_do_thing');
    expect(manager.isConnected('srv-g')).toBe(true);
  });

  it('marks the server as errored and closes client+transport when connect() throws', async () => {
    mockConnect.mockRejectedValueOnce(new Error('boom'));
    const manager = new McpClientManager();
    const config: McpServerConfig = { name: 'srv-h', transport: 'streamable-http', url: 'https://example.com/mcp' };
    await expect(manager.connect(config)).rejects.toThrow('boom');
    const state = manager.listStates().find(s => s.config.name === 'srv-h');
    expect(state?.status).toBe('error');
    expect(mockClose).toHaveBeenCalled();
  });
});
