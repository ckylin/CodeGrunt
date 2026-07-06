// ── MCP Client Manager ────────────────────────────────────────────────────
// Manages connections to MCP servers and exposes their tools to CodeGrunt's
// ToolRegistry. Supports stdio and SSE transports.
//
// Usage:
//   const mgr = getMcpManager();
//   await mgr.connectAll();      // connect all configured servers
//   await mgr.connect(config);   // connect a single server
//   mgr.disconnect(name);        // disconnect
//   mgr.listStates();            // server status summary

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig, McpServerState } from './types.js';
import { loadMcpConfig } from './config.js';
import { getLogger } from '../observability/logger.js';
import type { Tool, ToolResult } from '../../types.js';

const log = getLogger('mcp');

const CLIENT_INFO = { name: 'codegrunt', version: '0.1.2' };
const CONNECT_TIMEOUT_MS = 15_000;

// ── MCP tool wrapper ──────────────────────────────────────────────────────

function makeMcpTool(
  client: Client,
  toolDef: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  serverName: string,
): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: `mcp_${serverName}_${toolDef.name}`,
        description: `[MCP:${serverName}] ${toolDef.description ?? toolDef.name}`,
        parameters: (toolDef.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const result = await client.callTool({
          name: toolDef.name,
          arguments: args as Record<string, unknown>,
        });

        // MCP result is an array of content items
        const contents = result.content as Array<{ type: string; text?: string }> | undefined;
        const text = (contents ?? [])
          .filter(c => c.type === 'text')
          .map(c => c.text ?? '')
          .join('\n');

        const isError = result.isError === true;
        return isError
          ? { success: false, output: '', error: text || 'MCP tool returned an error' }
          : { success: true, output: text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: '', error: `MCP call failed: ${msg}` };
      }
    },
  };
}

// ── Manager ───────────────────────────────────────────────────────────────

export class McpClientManager {
  private clients = new Map<string, Client>();
  private states = new Map<string, McpServerState>();
  private registeredToolNames = new Map<string, string[]>(); // serverName → tool names

  /** Connect all servers from ~/.codegrunt/mcp.json, return all Tool objects */
  async connectAll(): Promise<Tool[]> {
    const config = await loadMcpConfig();
    if (config.servers.length === 0) return [];

    log.info('Connecting MCP servers', { count: config.servers.length });

    const results = await Promise.allSettled(
      config.servers.map(s => this.connect(s))
    );

    const tools: Tool[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') tools.push(...r.value);
      else log.warn('MCP connect failed', { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
    return tools;
  }

  /** Connect a single MCP server and return its Tool objects for registration */
  async connect(config: McpServerConfig): Promise<Tool[]> {
    // Disconnect existing connection if any
    this.disconnect(config.name);

    log.info('Connecting MCP server', { name: config.name, transport: config.transport });

    let transport;
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`MCP stdio server "${config.name}" requires a command`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      });
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error(`MCP SSE server "${config.name}" requires a url`);
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      throw new Error(`Unknown MCP transport: ${(config as McpServerConfig).transport}`);
    }

    const client = new Client(CLIENT_INFO);

    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
      ),
    ]);

    this.clients.set(config.name, client);

    const toolsResult = await client.listTools();
    const toolDefs = toolsResult.tools ?? [];
    const tools = toolDefs.map(t => makeMcpTool(client, t, config.name));
    const toolNames = tools.map(t => t.definition.function.name);

    this.states.set(config.name, { config, status: 'connected', toolNames });
    this.registeredToolNames.set(config.name, toolNames);

    log.info('MCP server connected', { name: config.name, tools: toolNames.length });
    return tools;
  }

  /** Disconnect a server and deregister its tools */
  disconnect(name: string): void {
    const client = this.clients.get(name);
    if (client) {
      client.close().catch(() => {});
      this.clients.delete(name);
    }
    this.states.set(name, {
      config: this.states.get(name)?.config ?? { name, transport: 'stdio' },
      status: 'disconnected',
      toolNames: [],
    });
    this.registeredToolNames.delete(name);
    log.info('MCP server disconnected', { name });
  }

  /** Disconnect all */
  disconnectAll(): void {
    for (const name of this.clients.keys()) {
      this.disconnect(name);
    }
  }

  listStates(): McpServerState[] {
    return Array.from(this.states.values());
  }

  isConnected(name: string): boolean {
    return this.states.get(name)?.status === 'connected';
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let _manager: McpClientManager | null = null;

export function getMcpManager(): McpClientManager {
  if (!_manager) _manager = new McpClientManager();
  return _manager;
}
