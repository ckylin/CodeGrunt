import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import type { CodeGruntConfig } from '../types.js';
import { selectFromList } from '../utils/select.js';
import { validateApiKey } from '../providers/deepseek/client.js';
import { saveConfig } from '../config.js';
import { DEEPSEEK_MODELS } from '../models.js';
import { withPrompt } from '../utils/prompt.js';

const CONFIG_DIR = join(homedir(), '.codegrunt');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export async function runSetup(existingConfig: CodeGruntConfig): Promise<CodeGruntConfig> {
  console.log(chalk.bold('\nWelcome to CodeGrunt!'));
  console.log(chalk.gray("Let's set up your configuration.\n"));
  console.log(
    chalk.gray('Get your DeepSeek API key at: ') +
    chalk.cyan('https://platform.deepseek.com/api_keys') + '\n',
  );

  // ── API Key ──────────────────────────────────────────────────────────────
  const apiKey = await withPrompt(async (ask) => {
    while (true) {
      const candidate = (await ask(chalk.bold('DeepSeek API Key: '))).trim();
      if (!candidate) {
        console.log(chalk.yellow('API key cannot be empty.'));
        continue;
      }
      process.stdout.write(chalk.gray('Validating API key…'));
      const err = await validateApiKey(candidate, existingConfig.baseURL);
      process.stdout.write('\r' + ' '.repeat(30) + '\r');
      if (!err) return candidate;
      console.log(chalk.red(`✗ ${err} Please try again.`));
    }
  });

  // ── Model selection — arrow-key dropdown ─────────────────────────────────
  console.log();
  const selectedModel = await selectFromList(
    'Select model',
    DEEPSEEK_MODELS.map((m) => ({ value: m.id, label: m.label, desc: m.description })),
    existingConfig.model,
  );
  const model = selectedModel ?? existingConfig.model;

  const config: CodeGruntConfig = { ...existingConfig, apiKey, model };
  const selected = DEEPSEEK_MODELS.find((m) => m.id === model);

  // Delegate to the canonical saveConfig in config.ts (single source of truth
  // for config persistence — avoids duplicate serialization logic).
  await saveConfig(config);

  console.log(
    chalk.green(`\n✓ Config saved`) +
    chalk.gray(` — model: `) + chalk.cyan(selected?.label ?? model) +
    chalk.gray(` → ${CONFIG_PATH}\n`),
  );

  return config;
}
