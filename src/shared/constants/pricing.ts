/** 模型定价（每 1M tokens，美元）— 仅包含 PROVIDER_REGISTRY 中注册的模型 */
export const MODEL_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  // DeepSeek — V4 官方价格待公告，先沿用 V3.2 价格作为近似，实测后校正
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.55, output: 2.19 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // Anthropic
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25 },
  // Zhipu
  'glm-5': { input: 0.05, output: 0.05 },
  'glm-4.7': { input: 0.05, output: 0.05 },
  'glm-4.6v': { input: 0.05, output: 0.05 },
  'glm-4.7-flash': { input: 0, output: 0 },
  'glm-4.6v-flash': { input: 0, output: 0 },
  // Moonshot
  'kimi-k2.6': { input: 0.6, output: 2.5 },
  'kimi-k2.5': { input: 0, output: 0 },
  'moonshot-v1-8k': { input: 0.12, output: 0.12 },
  'moonshot-v1-32k': { input: 0.24, output: 0.24 },
  'moonshot-v1-128k': { input: 0.6, output: 0.6 },
  // Fallback
  'default': { input: 1, output: 3 },
};

export const API_VERSIONS = {
  ANTHROPIC: '2023-06-01',
} as const;
