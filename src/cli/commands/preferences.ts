import chalk from 'chalk';
import type { CodeGruntConfig } from '../../types.js';
import { selectFromList } from '../../utils/select.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

export async function switchReasoningEffort(
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  const validEfforts = ['low', 'medium', 'high'] as const;

  if (arg && validEfforts.includes(arg as (typeof validEfforts)[number])) {
    const effort = arg as 'low' | 'medium' | 'high';
    console.log(
      chalk.green(`✓ Reasoning effort set to ${chalk.bold(effort)}`) +
      chalk.gray(' (only applies to reasoner/R1 models)'),
    );
    return { type: 'config_changed', config: { ...config, reasoningEffort: effort } };
  }

  // Interactive picker
  const selected = await selectFromList(
    'Select reasoning effort (only applies to R1/reasoner models)',
    [
      { value: 'low', label: 'Low', desc: 'Faster responses, less thinking' },
      { value: 'medium', label: 'Medium', desc: 'Balanced (default)' },
      { value: 'high', label: 'High', desc: 'Most thorough, slower responses' },
    ],
    config.reasoningEffort ?? 'medium',
  );

  if (!selected || selected === config.reasoningEffort) {
    console.log(chalk.gray('Reasoning effort unchanged.'));
    return { type: 'handled' };
  }

  console.log(chalk.green(`✓ Reasoning effort set to ${chalk.bold(selected)}`));
  return {
    type: 'config_changed',
    config: { ...config, reasoningEffort: selected as 'low' | 'medium' | 'high' },
  };
}

async function switchTheme(
  arg: string,
  config: CodeGruntConfig,
): Promise<SlashCommandResult> {
  const validThemes = ['dark', 'light'] as const;
  const normalized = arg.toLowerCase();

  if (normalized && validThemes.includes(normalized as (typeof validThemes)[number])) {
    const theme = normalized as 'dark' | 'light';
    console.log(chalk.green(`✓ Theme set to ${chalk.bold(theme)}`));
    return { type: 'config_changed', config: { ...config, theme } };
  }

  const selected = await selectFromList(
    'Select theme',
    [
      { value: 'dark', label: 'Dark', desc: 'Default — accent tuned for dark terminal backgrounds' },
      { value: 'light', label: 'Light', desc: 'Darker accent/muted colors for light terminal backgrounds' },
    ],
    config.theme ?? 'dark',
  );

  if (!selected || selected === config.theme) {
    console.log(chalk.gray('Theme unchanged.'));
    return { type: 'handled' };
  }

  console.log(chalk.green(`✓ Theme set to ${chalk.bold(selected)}`));
  return { type: 'config_changed', config: { ...config, theme: selected as 'dark' | 'light' } };
}

async function switchTrustMode(arg: string, config: CodeGruntConfig): Promise<SlashCommandResult> {
  const MODES = ['plan', 'code', 'auto'] as const;
  type TrustMode = typeof MODES[number];

  const DESCRIPTIONS: Record<TrustMode, string> = {
    plan: 'read-only — all write/shell tools are blocked',
    code: 'require confirmation for each destructive operation (default)',
    auto: 'auto-approve all operations for this session',
  };

  if (arg && MODES.includes(arg as TrustMode)) {
    const mode = arg as TrustMode;
    const label = mode === 'plan' ? chalk.yellow(mode) : mode === 'auto' ? chalk.green(mode) : chalk.cyan(mode);
    console.log(chalk.green('✓ Trust mode: ') + label + chalk.gray(`  — ${DESCRIPTIONS[mode]}`));
    return { type: 'config_changed', config: { ...config, trustMode: mode } };
  }

  const selected = await selectFromList(
    'Select trust mode',
    MODES.map(m => ({ value: m, label: m, desc: DESCRIPTIONS[m] })),
    config.trustMode ?? 'code',
  );

  if (!selected || selected === (config.trustMode ?? 'code')) {
    console.log(chalk.gray('Trust mode unchanged.'));
    return { type: 'handled' };
  }

  const mode = selected as TrustMode;
  const label = mode === 'plan' ? chalk.yellow(mode) : mode === 'auto' ? chalk.green(mode) : chalk.cyan(mode);
  console.log(chalk.green('✓ Trust mode: ') + label + chalk.gray(`  — ${DESCRIPTIONS[mode]}`));
  return { type: 'config_changed', config: { ...config, trustMode: mode } };
}

export const preferenceCommands: SlashCommand[] = [
  {
    name: 'effort',
    aliases: ['reasoning'],
    desc: 'Set reasoning effort: low (flash) / medium (auto) / high (pro+thinking)',
    run: ({ args, config }) => switchReasoningEffort(args, config),
  },
  {
    name: 'theme',
    desc: 'Set TUI color theme: dark (default) / light',
    run: ({ args, config }) => switchTheme(args, config),
  },
  {
    name: 'trust',
    desc: 'Set trust mode: plan (read-only) / code (confirm) / auto (yes-all)',
    run: ({ args, config }) => switchTrustMode(args, config),
  },
];
