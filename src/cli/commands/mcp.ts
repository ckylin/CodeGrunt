import chalk from 'chalk';
import { getMcpManager } from '../../core/mcp/manager.js';
import { addMcpServer, removeMcpServer, loadMcpConfig } from '../../core/mcp/config.js';
import { searchMcpRegistry } from '../../core/mcp/registry.js';
import type { McpServerConfig } from '../../core/mcp/types.js';
import { getToolRegistry } from '../../core/tools/registry.js';
import type { SlashCommand } from './types.js';

// /mcp list                            — list configured servers and their status
// /mcp add <name> stdio <command>      — add a stdio server
// /mcp add <name> sse <url>            — add an SSE server
// /mcp add <name> streamable-http <url> — add a Streamable HTTP server
// /mcp remove <name>                   — remove a server
// /mcp search <keyword>                — search the official MCP registry

async function handleMcp(rest: string[]): Promise<void> {
  const sub = rest[0]?.toLowerCase();

  if (!sub || sub === 'list') {
    const config = await loadMcpConfig();
    const manager = getMcpManager();
    const states = manager.listStates();

    if (config.servers.length === 0) {
      console.log(chalk.gray('\nNo MCP servers configured.'));
      console.log(chalk.gray('Add one with: /mcp add <name> stdio <command>'));
      console.log(chalk.gray('         or: /mcp add <name> sse <url>\n'));
      return;
    }

    console.log(`\n${chalk.bold('MCP Servers')}\n`);
    for (const server of config.servers) {
      const state = states.find(s => s.config.name === server.name);
      const statusIcon = state?.status === 'connected' ? chalk.green('●') : chalk.gray('○');
      const tools = state?.toolNames.length ?? 0;
      const detail = server.transport === 'stdio' ? server.command ?? '' : server.url ?? '';
      console.log(`  ${statusIcon} ${chalk.cyan(server.name)} ${chalk.gray(`[${server.transport}]`)} ${chalk.gray(detail)}`);
      if (tools > 0) console.log(`    ${chalk.gray(`${tools} tool${tools > 1 ? 's' : ''}`)}`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const name = rest[1];
    const transport = rest[2]?.toLowerCase() as 'stdio' | 'sse' | 'streamable-http' | undefined;
    const target = rest.slice(3).join(' ');

    if (!name || !transport || !target) {
      console.log(chalk.yellow('Usage: /mcp add <name> stdio <command>'));
      console.log(chalk.yellow('       /mcp add <name> sse <url>'));
      console.log(chalk.yellow('       /mcp add <name> streamable-http <url>'));
      return;
    }

    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'streamable-http') {
      console.log(chalk.yellow('Transport must be "stdio", "sse", or "streamable-http"'));
      return;
    }

    const serverConfig: McpServerConfig = transport === 'stdio'
      ? { name, transport: 'stdio', command: target.split(' ')[0], args: target.split(' ').slice(1) }
      : { name, transport, url: target };

    await addMcpServer(serverConfig);

    // Connect immediately
    const manager = getMcpManager();
    try {
      const tools = await manager.connect(serverConfig);
      const registry = getToolRegistry();
      for (const tool of tools) registry.register(tool, 'mcp');
      console.log(chalk.green(`✓ MCP server "${name}" added and connected (${tools.length} tools)`));
    } catch (err) {
      console.log(chalk.yellow(`✓ MCP server "${name}" saved (connection failed: ${err instanceof Error ? err.message : String(err)})`));
      console.log(chalk.gray('  The server will be connected on next startup.'));
    }
    return;
  }

  if (sub === 'remove') {
    const name = rest[1];
    if (!name) { console.log(chalk.yellow('Usage: /mcp remove <name>')); return; }

    const manager = getMcpManager();
    manager.disconnect(name);

    const removed = await removeMcpServer(name);
    if (removed) {
      console.log(chalk.green(`✓ MCP server "${name}" removed`));
    } else {
      console.log(chalk.yellow(`Server "${name}" not found`));
    }
    return;
  }

  if (sub === 'search') {
    const keyword = rest.slice(1).join(' ').trim();
    if (!keyword) { console.log(chalk.yellow('Usage: /mcp search <keyword>')); return; }

    console.log(chalk.gray(`\nSearching MCP registry for "${keyword}"...`));
    const results = await searchMcpRegistry(keyword);

    if (results.length === 0) {
      console.log(chalk.gray('No servers found (or the registry is unreachable).\n'));
      return;
    }

    console.log(`\n${chalk.bold('MCP Registry Results')}\n`);
    for (const r of results) {
      console.log(`  ${chalk.cyan(r.name)}`);
      if (r.description) console.log(`    ${chalk.gray(r.description)}`);

      if (r.install.kind === 'stdio') {
        const cmd = `${r.install.command} ${r.install.args.join(' ')}`.trim();
        console.log(`    ${chalk.gray('→')} /mcp add <name> stdio ${cmd}`);
      } else if (r.install.kind === 'remote') {
        console.log(`    ${chalk.gray('→')} /mcp add <name> ${r.install.transport} ${r.install.url}`);
      } else {
        console.log(`    ${chalk.gray('(no supported install method found)')}`);
      }
      console.log('');
    }
    return;
  }

  console.log(chalk.yellow(`Unknown /mcp subcommand: ${sub}`));
  console.log(chalk.gray('Available: list, add, remove, search'));
}

export const mcpCommands: SlashCommand[] = [
  {
    name: 'mcp',
    desc: 'Manage MCP servers: /mcp list | add | remove | search',
    async run({ rest }) {
      await handleMcp(rest);
      return { type: 'handled' };
    },
  },
];
