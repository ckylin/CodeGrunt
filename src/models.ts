export interface ModelInfo {
  id: string;
  label: string;
  description: string;
}

export const DEEPSEEK_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    description: 'General-purpose chat model (aliased to latest)',
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Fast & cheap — used for classification and planning',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Most capable, best for complex multi-step tasks',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek R1 Reasoner',
    description: 'Chain-of-thought reasoning, 1M context — for hard problems',
  },
];
