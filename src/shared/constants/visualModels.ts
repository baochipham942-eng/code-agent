// 视觉生成模型注册表（D1 单一真源）。只含「出图/出视频」模型，绝不含聊天模型（D7）。
// P1 仅 image 部分；video 部分在 P2 追加。

export type ImageCap = 't2i' | 'maskEdit' | 'expand' | 'annotEdit';
export type ImageEngineId = 'wanx' | 'cogview' | 'flux' | 'gptimage';
export type VisualProviderId = 'dashscope' | 'zhipu' | 'openrouter' | 'gptimage';

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

export function imageEngineForModel(id: string): ImageEngineId {
  const m = imageModelById(id);
  if (!m) throw new Error(`未知生图模型 id: ${id}`);
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
  provider: VisualProviderId; // P2 仅 'dashscope'
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
