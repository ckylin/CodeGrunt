import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import { selectFromList } from '../../utils/select.js';
import { NUMERIC_CONFIG_PARAMS, type NumericConfigParam } from './config-params.js';
import { switchReasoningEffort } from './preferences.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

// /config                        — show current config
// /config temperature [val]      — set temperature
// /config maxtokens [val]        — set max tokens
// /config topp [val]             — set top-p
// /config frequencypenalty [val] — set frequency penalty
// /config presencepenalty [val]  — set presence penalty
// /config reasoning [level]      — set reasoning effort

async function switchNumericConfig(
  param: NumericConfigParam,
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  if (arg) {
    const val = param.parse(arg);
    if (!param.validate(val)) {
      console.log(chalk.yellow(param.validationMsg));
      return { type: 'handled' };
    }
    console.log(chalk.green(`✓ ${param.label} set to ${chalk.bold(String(val))}`));
    return { type: 'config_changed', config: param.apply(config, val) };
  }

  const selected = await selectFromList(
    `Select ${param.label.toLowerCase()}`,
    param.items,
    param.currentValue(config),
  );

  if (!selected || param.unchanged(config, param.parse(selected))) {
    console.log(chalk.gray(`${param.label} unchanged.`));
    return { type: 'handled' };
  }

  const val = param.parse(selected);
  console.log(chalk.green(`✓ ${param.label} set to ${chalk.bold(String(val))}`));
  return { type: 'config_changed', config: param.apply(config, val) };
}

async function handleConfig(
  rest: string[],
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  const sub = rest[0]?.toLowerCase();
  const val = rest.slice(1).join(' ').trim();

  const numericParam = sub ? NUMERIC_CONFIG_PARAMS[sub] ?? NUMERIC_CONFIG_PARAMS[sub.replace('_', '')] : undefined;
  if (numericParam) {
    return switchNumericConfig(numericParam, val, config);
  }

  switch (sub) {
    case 'reasoning':
    case 'effort':
      return switchReasoningEffort(val, config);

    default:
      if (!sub) {
        printConfigOverview(config);
        return { type: 'handled' };
      }
      console.log(
        chalk.yellow(`Unknown config key: ${sub}\n`) +
        chalk.gray('Available: temperature, maxtokens, topp, frequencypenalty, presencepenalty, reasoning'),
      );
      return { type: 'handled' };
  }
}

function printConfigOverview(config: CodeGruntConfig): void {
  console.log(`
${chalk.bold('Current Configuration')}

  ${chalk.gray('temperature:')}        ${chalk.cyan(String(config.temperature))}
  ${chalk.gray('max_tokens:')}         ${chalk.cyan(String(config.maxTokens))}
  ${chalk.gray('top_p:')}              ${chalk.cyan(String(config.topP ?? '1'))}
  ${chalk.gray('frequency_penalty:')}  ${chalk.cyan(String(config.frequencyPenalty ?? '0'))}
  ${chalk.gray('presence_penalty:')}   ${chalk.cyan(String(config.presencePenalty ?? '0'))}
  ${chalk.gray('reasoning_effort:')}   ${chalk.cyan(config.reasoningEffort ?? 'medium')}

${chalk.gray('Use /config <key> <value> to change a setting, e.g. /config temperature 0.8')}
`);
}

export const configCommands: SlashCommand[] = [
  {
    name: 'config',
    desc: 'View or change config (temperature, reasoning, etc.)',
    run: ({ rest, config }) => handleConfig(rest, config),
  },
];
