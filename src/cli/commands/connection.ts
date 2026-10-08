import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import { DEEPSEEK_MODELS } from '../../models.js';
import { validateApiKey } from '../../providers/deepseek/client.js';
import { selectFromList } from '../../utils/select.js';
import { askOnce } from '../../utils/prompt.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

async function switchModel(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  // /model deepseek-v4-pro  — direct switch by ID
  if (arg) {
    const match = DEEPSEEK_MODELS.find((m) => m.id === arg || m.label.toLowerCase() === arg.toLowerCase());
    if (!match) {
      console.log(chalk.yellow(`Unknown model: ${arg}`));
      console.log(chalk.gray('Available: ' + DEEPSEEK_MODELS.map((m) => m.id).join(', ')));
      return { type: 'handled' };
    }
    console.log(chalk.green(`✓ Switched to ${chalk.bold(match.label)}`) + chalk.gray(` (${match.id})`));
    return { type: 'model_changed', config: { ...config, model: match.id } };
  }

  // /model — arrow-key dropdown picker
  const selected = await selectFromList(
    'Select model',
    DEEPSEEK_MODELS.map((m) => ({ value: m.id, label: m.label, desc: m.description })),
    config.model,
  );

  if (!selected || selected === config.model) {
    console.log(chalk.gray('Model unchanged.'));
    return { type: 'handled' };
  }

  const match = DEEPSEEK_MODELS.find((m) => m.id === selected)!;
  console.log(chalk.green(`✓ Switched to ${chalk.bold(match.label)}`) + chalk.gray(` (${selected})`));
  return { type: 'model_changed', config: { ...config, model: selected } };
}

async function switchToken(
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  // If an argument is provided, use it directly
  if (arg) {
    const trimmed = arg.trim();
    if (trimmed.length < 10) {
      console.log(chalk.yellow('API key seems too short. Please check and try again.'));
      return { type: 'handled' };
    }
    process.stdout.write(chalk.gray('Validating API key…'));
    const err = await validateApiKey(trimmed, config.baseURL);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
    if (err) {
      console.log(chalk.red(`✗ ${err} Key not saved.`));
      return { type: 'handled' };
    }
    console.log(chalk.green('✓ API key updated'));
    console.log(chalk.gray(`  Key: ${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`));
    return { type: 'config_changed', config: { ...config, apiKey: trimmed } };
  }

  // Interactive input (readline for direct text input)
  console.log(chalk.gray('Enter your new DeepSeek API key (get one at https://platform.deepseek.com/api_keys):'));
  const newKey = (await askOnce(chalk.bold('API Key: '))).trim();

  if (!newKey) {
    console.log(chalk.gray('API key unchanged.'));
    return { type: 'handled' };
  }

  if (newKey.length < 10) {
    console.log(chalk.yellow('API key seems too short. Key unchanged.'));
    return { type: 'handled' };
  }

  process.stdout.write(chalk.gray('Validating API key…'));
  const err = await validateApiKey(newKey, config.baseURL);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (err) {
    console.log(chalk.red(`✗ ${err} Key not saved.`));
    return { type: 'handled' };
  }

  console.log(chalk.green('✓ API key updated'));
  console.log(chalk.gray(`  Key: ${newKey.slice(0, 4)}...${newKey.slice(-4)}`));
  return { type: 'config_changed', config: { ...config, apiKey: newKey } };
}

function handleBaseUrl(arg: string, config: CodeGruntConfig): SlashCommandResult {
  const DEFAULT_URL = 'https://api.deepseek.com';
  const url = arg.trim();

  if (!url) {
    console.log(`\n${chalk.bold('Current base URL:')} ${chalk.cyan(config.baseURL ?? DEFAULT_URL)}`);
    console.log(chalk.gray('Usage: /baseurl <url>  — set a custom DeepSeek API base URL'));
    console.log(chalk.gray(`       /baseurl reset  — restore to ${DEFAULT_URL}\n`));
    return { type: 'handled' };
  }

  if (url === 'reset') {
    console.log(chalk.green(`✓ Base URL reset to ${chalk.cyan(DEFAULT_URL)}`));
    return { type: 'config_changed', config: { ...config, baseURL: DEFAULT_URL } };
  }

  try {
    new URL(url); // validate
  } catch {
    console.log(chalk.yellow(`Invalid URL: ${url}`));
    return { type: 'handled' };
  }

  console.log(chalk.green(`✓ Base URL set to ${chalk.cyan(url)}`));
  console.log(chalk.gray('  Restart the session for the new URL to take effect on the provider.'));
  return { type: 'config_changed', config: { ...config, baseURL: url } };
}

async function handleSearchEngine(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  type Engine = 'mojeek' | 'searxng' | 'duckduckgo';
  const ENGINES: Engine[] = ['mojeek', 'searxng', 'duckduckgo'];
  const DESCS: Record<Engine, string> = {
    mojeek: 'privacy-first, no API key required (default)',
    searxng: 'self-hosted metasearch — set CODEGRUNT_SEARXNG_URL',
    duckduckgo: 'DuckDuckGo instant answers (rate-limited)',
  };

  const current = config.searchEngine ?? 'mojeek';

  if (arg && ENGINES.includes(arg as Engine)) {
    const engine = arg as Engine;
    console.log(chalk.green(`✓ Search engine: ${chalk.cyan(engine)}`) + chalk.gray(`  — ${DESCS[engine]}`));
    if (engine === 'searxng' && !config.searxngUrl) {
      console.log(chalk.yellow('  Set your SearXNG URL with: CODEGRUNT_SEARXNG_URL=http://localhost:8080'));
    }
    return { type: 'config_changed', config: { ...config, searchEngine: engine } };
  }

  const selected = await selectFromList(
    'Select web search engine',
    ENGINES.map(e => ({ value: e, label: e, desc: DESCS[e] })),
    current,
  );

  if (!selected || selected === current) {
    console.log(chalk.gray('Search engine unchanged.'));
    return { type: 'handled' };
  }

  const engine = selected as Engine;
  console.log(chalk.green(`✓ Search engine: ${chalk.cyan(engine)}`));
  return { type: 'config_changed', config: { ...config, searchEngine: engine } };
}

export const connectionCommands: SlashCommand[] = [
  {
    name: 'model',
    desc: 'Switch model interactively',
    run: ({ args, config }) => switchModel(args, config),
  },
  {
    name: 'token',
    aliases: ['apikey'],
    desc: 'Change the DeepSeek API key',
    hidden: true,
    run: ({ args, config }) => switchToken(args, config),
  },
  {
    name: 'baseurl',
    desc: 'Set custom DeepSeek API base URL (for mirrors / proxies)',
    run: ({ args, config }) => handleBaseUrl(args, config),
  },
  {
    name: 'search-engine',
    desc: 'Set web search engine: mojeek (default) / searxng / duckduckgo',
    run: ({ args, config }) => handleSearchEngine(args, config),
  },
];
