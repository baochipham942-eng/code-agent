// 视觉生成模型注册表（D1 单一真源）。只含「出图/出视频」模型，绝不含聊天模型（D7）。
// P1 仅 image 部分；video 部分在 P2 追加。

export type ImageCap = 't2i' | 'maskEdit' | 'expand' | 'annotEdit';
// 内置静态引擎：映射到 imageGenerationService.generateImage 的 engine（与 service 的 ImageEngine 对齐）。
export type StaticImageEngineId = 'wanx' | 'cogview' | 'flux' | 'gptimage';
// 'openai-compat'：用户自填的 OpenAI 兼容生图端点（借鉴项①）。仅 t2i，不进任何静态 helper
// （imageEngineForModel 只认内置表且对 openai-compat 显式抛错，custom id 走 IPC 独立分支）。
export type ImageEngineId = StaticImageEngineId | 'openai-compat';
export type VisualProviderId = 'dashscope' | 'zhipu' | 'openrouter' | 'gptimage' | 'minimax' | 'google' | 'ark' | 'custom';

export interface VisualImageModel {
  /** 切换器/持久化用的稳定选择键。 */
  id: string;
  /** UI 显示名（i18n 在 label 之外另给，本字段是中性名）。 */
  label: string;
  provider: VisualProviderId;
  /** 路由到 imageGenerationService.generateImage 的 engine。 */
  engine: ImageEngineId;
  caps: ImageCap[];
}

export const IMAGE_MODELS: readonly VisualImageModel[] = [
  { id: 'wanx-t2i', label: '通义万相', provider: 'dashscope', engine: 'wanx', caps: ['t2i', 'maskEdit', 'expand'] },
  { id: 'gpt-image-2', label: 'GPT-image-2', provider: 'gptimage', engine: 'gptimage', caps: ['t2i', 'annotEdit'] },
  { id: 'cogview-4', label: 'CogView-4', provider: 'zhipu', engine: 'cogview', caps: ['t2i'] },
  { id: 'flux-2', label: 'FLUX.2', provider: 'openrouter', engine: 'flux', caps: ['t2i'] },
];

export function imageModelById(id: string): VisualImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

// 硬边界（艾克斯审计修订 3）：只认内置静态表，返回静态 engine。custom（openai-compat）
// 永不进这里——未登记 id 抛"未知模型"，万一登记了 openai-compat 也显式拒绝，逼出图路由对
// custom 走独立分支，杜绝误用静态 helper 把自定义模型塞进内置 generateImage。
export function imageEngineForModel(id: string): StaticImageEngineId {
  const m = imageModelById(id);
  if (!m) throw new Error(`未知生图模型 id: ${id}`);
  if (m.engine === 'openai-compat') {
    throw new Error(`模型 ${id} 是自定义端点（openai-compat），不能走内置 engine 路由`);
  }
  return m.engine;
}

/** 默认走 wanx——设计模式底座（mask/扩图都依赖它）。 */
export function defaultImageModelId(): string {
  return 'wanx-t2i';
}

/** 返回声明了指定能力的全部视觉图像模型（驱动 cap 过滤的切换器/工具）。 */
export function imageModelsWithCap(cap: ImageCap): VisualImageModel[] {
  return IMAGE_MODELS.filter((m) => m.caps.includes(cap));
}

// ── 视频生成模型注册表（P2，单 provider dashscope）。能力标签 t2v/i2v 驱动模式过滤。 ──
export type VideoCap = 't2v' | 'i2v';

export interface VisualVideoModel {
  id: string;
  label: string;
  provider: VisualProviderId; // P2 dashscope；P3 增 minimax（海螺）
  caps: VideoCap[];
  /** 时长区间（秒）。固定时长模型令 min=default=max（如 i2v turbo 固定 5s）。 */
  minDurationSec: number;
  maxDurationSec: number;
  defaultDurationSec: number;
}

export const VIDEO_MODELS: readonly VisualVideoModel[] = [
  {
    id: 'wan2.7-t2v',
    label: '通义万相 文生视频',
    provider: 'dashscope',
    caps: ['t2v'],
    minDurationSec: 2,
    maxDurationSec: 15,
    defaultDurationSec: 5,
  },
  {
    id: 'wanx2.1-i2v-turbo',
    label: '通义万相 图生视频',
    provider: 'dashscope',
    caps: ['i2v'],
    minDurationSec: 5,
    maxDurationSec: 5, // turbo 档固定 5s
    defaultDurationSec: 5,
  },
  // P3 第二 provider：MiniMax 海螺（端点/模型名/必填字段经免费探针核实）。t2v 与 i2v 用不同模型；
  // 时长固定 6s（MVP 不暴露 duration 参数，用模型默认）。
  {
    id: 'MiniMax-Hailuo-02',
    label: '海螺 文生视频',
    provider: 'minimax',
    caps: ['t2v'],
    minDurationSec: 6,
    maxDurationSec: 6,
    defaultDurationSec: 6,
  },
  {
    id: 'I2V-01',
    label: '海螺 图生视频',
    provider: 'minimax',
    caps: ['i2v'],
    minDurationSec: 6,
    maxDurationSec: 6,
    defaultDurationSec: 6,
  },
  // Veo 3.1 原生（Spec 3，Google Gemini API 轻路径）。固定 8s。Veo 3/2 于 2026-06-30 停用，只列 3.1。
  {
    id: 'veo-3.1-fast-generate-preview',
    label: 'Veo 3.1 视频（快速）',
    provider: 'google',
    caps: ['t2v', 'i2v'],
    minDurationSec: 8,
    maxDurationSec: 8,
    defaultDurationSec: 8,
  },
  {
    id: 'veo-3.1-generate-preview',
    label: 'Veo 3.1 视频',
    provider: 'google',
    caps: ['t2v', 'i2v'],
    minDurationSec: 8,
    maxDurationSec: 8,
    defaultDurationSec: 8,
  },
  // Spec 2：Seedance 原生（火山方舟 Ark）。统一模型，t2v+i2v 同 id；duration 2~12s（dogfood 校准合法档）。
  // ⚠️ model id 带日期戳会轮换，以控制台实际可用 id 为准，轮换时改此常量。
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0',
    provider: 'ark',
    caps: ['t2v', 'i2v'],
    minDurationSec: 3,
    maxDurationSec: 12,
    defaultDurationSec: 5,
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast',
    provider: 'ark',
    caps: ['t2v', 'i2v'],
    minDurationSec: 3,
    maxDurationSec: 12,
    defaultDurationSec: 5,
  },
];

export function videoModelById(id: string): VisualVideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** 默认走 t2v 文生视频（最常用入口）。 */
export function defaultVideoModelId(): string {
  return 'wan2.7-t2v';
}

export function videoModelsWithCap(cap: VideoCap): VisualVideoModel[] {
  return VIDEO_MODELS.filter((m) => m.caps.includes(cap));
}

/** 把请求时长按模型区间 clamp（非有限/越界 → 回退默认/边界），杜绝付费空/越界调用。 */
export function clampVideoDuration(model: VisualVideoModel, durationSec?: number): number {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec)) return model.defaultDurationSec;
  return Math.min(model.maxDurationSec, Math.max(model.minDurationSec, Math.round(durationSec)));
}
