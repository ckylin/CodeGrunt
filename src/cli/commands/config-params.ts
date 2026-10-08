import type { CodeGruntConfig } from '../../types.js';

export interface NumericConfigParam {
  key: keyof CodeGruntConfig;
  label: string;
  parse: (s: string) => number;
  validate: (n: number) => boolean;
  validationMsg: string;
  items: Array<{ value: string; label: string; desc: string }>;
  currentValue: (cfg: CodeGruntConfig) => string;
  unchanged: (cfg: CodeGruntConfig, n: number) => boolean;
  apply: (cfg: CodeGruntConfig, n: number) => CodeGruntConfig;
}

export const NUMERIC_CONFIG_PARAMS: Record<string, NumericConfigParam> = {
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= 0 && n <= 2,
    validationMsg: 'Temperature must be a number between 0 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'Deterministic, consistent output' },
      { value: '0.2', label: '0.2', desc: 'Mostly deterministic (default)' },
      { value: '0.5', label: '0.5', desc: 'Balanced' },
      { value: '0.8', label: '0.8', desc: 'More creative' },
      { value: '1.0', label: '1.0', desc: 'Creative' },
      { value: '1.5', label: '1.5', desc: 'Very creative' },
      { value: '2.0', label: '2.0', desc: 'Maximum creativity' },
    ],
    currentValue: (cfg) => String(cfg.temperature),
    unchanged: (cfg, n) => n === cfg.temperature,
    apply: (cfg, n) => ({ ...cfg, temperature: n }),
  },
  maxtokens: {
    key: 'maxTokens',
    label: 'Max tokens',
    parse: (s) => parseInt(s, 10),
    validate: (n) => !isNaN(n) && n >= 256 && n <= 65536,
    validationMsg: 'Max tokens must be an integer between 256 and 65536.',
    items: [
      { value: '1024', label: '1024', desc: 'Short responses' },
      { value: '2048', label: '2048', desc: 'Medium responses' },
      { value: '4096', label: '4096', desc: 'Standard length' },
      { value: '8192', label: '8192', desc: 'Long responses (default)' },
      { value: '16384', label: '16384', desc: 'Very long responses' },
      { value: '32768', label: '32768', desc: 'Maximum length responses' },
    ],
    currentValue: (cfg) => String(cfg.maxTokens),
    unchanged: (cfg, n) => n === cfg.maxTokens,
    apply: (cfg, n) => ({ ...cfg, maxTokens: n }),
  },
  topp: {
    key: 'topP',
    label: 'Top-p',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= 0 && n <= 1,
    validationMsg: 'Top-p must be a number between 0 and 1.',
    items: [
      { value: '1', label: '1.0', desc: 'Consider all tokens (default)' },
      { value: '0.9', label: '0.9', desc: 'Top 90% probability mass' },
      { value: '0.8', label: '0.8', desc: 'Top 80%' },
      { value: '0.7', label: '0.7', desc: 'Top 70%' },
      { value: '0.5', label: '0.5', desc: 'Top 50% (more focused)' },
    ],
    currentValue: (cfg) => cfg.topP !== undefined ? String(cfg.topP) : '1',
    unchanged: (cfg, n) => cfg.topP !== undefined && n === cfg.topP,
    apply: (cfg, n) => ({ ...cfg, topP: n }),
  },
  frequencypenalty: {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= -2 && n <= 2,
    validationMsg: 'Frequency penalty must be a number between -2 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'No penalty (default)' },
      { value: '0.3', label: '0.3', desc: 'Slight repetition reduction' },
      { value: '0.6', label: '0.6', desc: 'Moderate repetition reduction' },
      { value: '1.0', label: '1.0', desc: 'Strong repetition reduction' },
      { value: '1.5', label: '1.5', desc: 'Very strong reduction' },
      { value: '2.0', label: '2.0', desc: 'Maximum reduction' },
    ],
    currentValue: (cfg) => cfg.frequencyPenalty !== undefined ? String(cfg.frequencyPenalty) : '0',
    unchanged: (cfg, n) => cfg.frequencyPenalty !== undefined && n === cfg.frequencyPenalty,
    apply: (cfg, n) => ({ ...cfg, frequencyPenalty: n }),
  },
  presencepenalty: {
    key: 'presencePenalty',
    label: 'Presence penalty',
    parse: parseFloat,
    validate: (n) => !isNaN(n) && n >= -2 && n <= 2,
    validationMsg: 'Presence penalty must be a number between -2 and 2.',
    items: [
      { value: '0', label: '0.0', desc: 'No penalty (default)' },
      { value: '0.3', label: '0.3', desc: 'Slight topic diversity' },
      { value: '0.6', label: '0.6', desc: 'Moderate topic diversity' },
      { value: '1.0', label: '1.0', desc: 'Strong topic diversity' },
      { value: '1.5', label: '1.5', desc: 'Very strong diversity' },
      { value: '2.0', label: '2.0', desc: 'Maximum diversity' },
    ],
    currentValue: (cfg) => cfg.presencePenalty !== undefined ? String(cfg.presencePenalty) : '0',
    unchanged: (cfg, n) => cfg.presencePenalty !== undefined && n === cfg.presencePenalty,
    apply: (cfg, n) => ({ ...cfg, presencePenalty: n }),
  },
};
