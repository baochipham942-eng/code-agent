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
  'glm-4-flash': { input: 0, output: 0 },
  'glm-4.6v-flash': { input: 0, output: 0 },
  // Moonshot
  'kimi-k2.6': { input: 0.6, output: 2.5 },
  'kimi-k2.5': { input: 0, output: 0 },
  'moonshot-v1-8k': { input: 0.12, output: 0.12 },
  'moonshot-v1-32k': { input: 0.24, output: 0.24 },
  'moonshot-v1-128k': { input: 0.6, output: 0.6 },
  // 小米 MiMo（Token Plan Max 包月，配额内不计费）
  'mimo-v2.5-pro': { input: 0, output: 0 },
  'mimo-v2.5': { input: 0, output: 0 },
  'mimo-v2-pro': { input: 0, output: 0 },
  'mimo-v2-omni': { input: 0, output: 0 },
  // Fallback
  'default': { input: 1, output: 3 },
};

/** 设计模式 flux 路由所用模型 id（schnell 档，成本低；供 generateImage 的 fluxModel 入参 + 价表查表）。 */
export const DESIGN_FLUX_MODEL = 'black-forest-labs/flux.2-klein-4b';

/**
 * 图像生成/编辑定价（每张，人民币元）。单一真源——禁在业务代码散落图像价格字面量。
 * key 为图像模型 id，必须与 imageGenerationService 返回的 actualModel 对齐。
 * - wanx 0.14/张：DashScope（百炼）实价，文生图与局部重绘同价。
 * - cogview-4：智谱公示价 0.06/张；cogview-3-flash 为免费档。
 * - 以下条目为保守估值，待真实账单验证后校正：
 *   - flux.2-klein-4b：OpenRouter schnell 档上界估算，避免低估成本提示。
 *   - gpt-image-2：GPT-Image 中转保守估值，落在 ¥0.1–0.3 区间取上界。
 */
export const IMAGE_PRICING_CNY: Record<string, number> = {
  'wanx2.1-t2i-turbo': 0.14,
  'wanx2.1-imageedit': 0.14,
  'cogview-4-250304': 0.06,
  'cogview-3-flash': 0,
  // 保守估值，待真实账单验证后校正
  [DESIGN_FLUX_MODEL]: 0.10,
  'gpt-image-2': 0.25,
  default: 0.14,
};

/** 设计画布出图/局部重绘所用模型 id（与 imageGenerationService 钦定引擎一致，供预估成本查表）。 */
export const DESIGN_IMAGE_MODELS = {
  generate: 'wanx2.1-t2i-turbo',
  edit: 'wanx2.1-imageedit',
} as const;

export const API_VERSIONS = {
  ANTHROPIC: '2023-06-01',
} as const;
