/** 模型定价条目（每 1M tokens，美元）。cacheRead/cacheWrite 缺省时按比例回退（见下方 ratio 常量）。 */
export interface ModelPricingEntry {
  input: number;
  output: number;
  /** 缓存命中读取价（prompt cache hit）。缺省 = input × DEFAULT_CACHE_READ_PRICE_RATIO */
  cacheRead?: number;
  /** 缓存写入价（Anthropic cache_creation）。缺省 = input × DEFAULT_CACHE_WRITE_PRICE_RATIO */
  cacheWrite?: number;
}

/** 无显式 cacheRead 价的模型按 input × 0.1 近似（Anthropic/DeepSeek/Moonshot 均为 ~0.1x 档） */
export const DEFAULT_CACHE_READ_PRICE_RATIO = 0.1;
/** 无显式 cacheWrite 价的模型按 input × 1.25 近似（Anthropic 5m ephemeral 档） */
export const DEFAULT_CACHE_WRITE_PRICE_RATIO = 1.25;

/** 模型定价（每 1M tokens，美元）— 仅包含 PROVIDER_REGISTRY 中注册的模型 */
export const MODEL_PRICING_PER_1M: Record<string, ModelPricingEntry> = {
  // DeepSeek — V4 官方价格待公告，先沿用 V3.2 价格作为近似，实测后校正；缓存命中为 0.1x 档
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.055 },
  'deepseek-chat': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-coder': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.055 },
  // OpenAI — cached input 为 0.5x 档
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  // Anthropic — cacheRead 0.1x / cacheWrite(5m ephemeral) 1.25x
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },
  // Zhipu
  'glm-5': { input: 0.05, output: 0.05 },
  'glm-4.7': { input: 0.05, output: 0.05 },
  'glm-4.6v': { input: 0.05, output: 0.05 },
  'glm-4.7-flash': { input: 0, output: 0 },
  'glm-4-flash': { input: 0, output: 0 },
  'glm-4.6v-flash': { input: 0, output: 0 },
  // Moonshot — K2 系缓存命中为 $0.15/M 档
  'kimi-k2.6': { input: 0.6, output: 2.5, cacheRead: 0.15 },
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

/**
 * 视频生成定价（每秒，人民币元）。单一真源——禁在业务代码散落视频价格字面量。
 * key 为视频模型 id，与 VIDEO_MODELS / generateVideo 返回的 actualModel 对齐。
 * 已按真实账单校正（2026-06-22，百炼控制台「官网目录价」）：t2v(wan2.7-t2v) 与
 * i2v(wanx2.1-i2v-turbo) 各一次 5s 出片均出账 ¥0.14/视频 → 折每秒 ≈¥0.028，取 0.03/s
 * （5s≈¥0.15，略偏保守安全侧）。>5s 时长按每秒线性外推（仅 5s 有实测，更长为估算）。
 */
export const VIDEO_PRICING_CNY_PER_SEC: Record<string, number> = {
  'wan2.7-t2v': 0.03,        // 通义万相文生视频，实测 ¥0.14/5s 折算
  'wanx2.1-i2v-turbo': 0.03, // 通义万相图生视频 turbo，实测 ¥0.14/5s 折算
  // P3 MiniMax 海螺：dogfood 后林晨控制台粗估两条 6s 片共 ~¥5 → ≈¥2.5/条 → 0.42/s（6s≈¥2.5）。
  // 「不方便精确看」故为粗值；比通义万相贵约 18x（海螺高端档）。需精确单价后再细调。
  'MiniMax-Hailuo-02': 0.42, // 海螺文生视频，控制台粗估折算
  'I2V-01': 0.42,            // 海螺图生视频，控制台粗估折算
  // Veo 3.1 原生（Spec 3，Gemini API）：fast $0.10/s、标准 $0.40/s（含音频，USD→CNY≈7.2）。
  // 固定 8s 出片：fast≈¥5.76、标准≈¥23.04。Veo 3/2 于 2026-06-30 停用，只列 3.1。
  'veo-3.1-fast-generate-preview': 0.72,
  'veo-3.1-generate-preview': 2.88,
  // Spec 2 Seedance（火山 Ark）：占位单价，dogfood 后按火山定价文档校准。fast 档更便宜。
  'doubao-seedance-2-0-260128': 0.15,
  'doubao-seedance-2-0-fast-260128': 0.08,
  default: 0.03,
};

/** 设计画布视频产物默认模型 id（供 composer 预估成本查表）。 */
export const DESIGN_VIDEO_MODELS = {
  t2v: 'wan2.7-t2v',
  i2v: 'wanx2.1-i2v-turbo',
} as const;

/**
 * 音乐生成定价（每首，人民币元）。单一真源——禁在业务代码散落音乐价格字面量。
 * key 为音乐模型 id（与 generateMusic 返回的 actualModel 对齐）。
 * MiniMax 音乐单价未公开，先取保守默认 ¥0.2/首，待真实账单校正。
 */
export const MUSIC_PRICING_CNY: Record<string, number> = {
  'music-2.6': 0.2, // MiniMax 音乐，价表待补（保守默认）
  default: 0.2,
};
