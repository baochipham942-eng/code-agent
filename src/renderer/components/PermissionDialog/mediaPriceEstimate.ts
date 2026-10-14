// N-MEDIA-GEN-PRICE-CARD：付费生成工具审批卡的「按次计费 · 参考价」估算——纯函数，
// 价格一律经 shared/media/*Cost.ts 查 pricing.ts 单一真源，本文件不持有价格字面量。
// 模型取 rawArgs.model（价表认识的 id 才认），否则用工具默认模型；说「参考」是因为
// provider 可能回退（如 CogView → FLUX），实际计费以账单为准。
import { IMAGE_PRICING_CNY, MUSIC_PRICING_CNY, VIDEO_PRICING_CNY_PER_SEC } from '@shared/constants/pricing';
import {
  GENERATION_TOOL_DEFAULT_MODELS,
  GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
} from '@shared/media/generationToolDefaults';
import { estimateImageCostCny } from '@shared/media/imageCost';
import { estimateMusicCostCny } from '@shared/media/musicCost';
import { estimateVideoCostCny } from '@shared/media/videoCost';

export interface MediaPriceEstimate {
  /** 计费单位：图片=张、视频=条、音乐=首。 */
  kind: 'image' | 'video' | 'music';
  /** 计费数量（图片批量 = prompt 条数；视频/音乐恒 1）。 */
  count: number;
  /** 单件参考价（元）；视频已按时长折算。 */
  unitPriceCny: number;
  /** 总参考价（元）= unitPriceCny × count。 */
  totalCny: number;
  /** 视频时长（秒），仅 kind === 'video'；供文案复述「（6 秒）」。 */
  durationSec?: number;
}

/** rawArgs.model 只有命中价表才认（避免未知 id 被成本函数回落到 default 单价）；否则用工具默认模型。 */
function pricedModelId(raw: unknown, table: Record<string, number>, fallback: string): string {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(table, raw) ? raw : fallback;
}

/** 估算付费生成工具一次调用的参考价；非付费生成工具（或参数不成立）返回 null，卡片不出价格行。 */
export function estimateMediaPriceCny(
  tool: string,
  args: Record<string, unknown> | null | undefined,
): MediaPriceEstimate | null {
  switch (tool) {
    case 'image_generate': {
      const prompt = args?.prompt;
      const count = Array.isArray(prompt)
        ? prompt.length
        : typeof prompt === 'string' && prompt.length > 0
          ? 1
          : 0;
      if (count < 1) return null;
      const model = pricedModelId(args?.model, IMAGE_PRICING_CNY, GENERATION_TOOL_DEFAULT_MODELS.image);
      const unitPriceCny = estimateImageCostCny(model);
      return { kind: 'image', count, unitPriceCny, totalCny: unitPriceCny * count };
    }
    case 'video_generate': {
      const rawDuration = args?.duration;
      const durationSec =
        typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
          ? rawDuration
          : GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC;
      const model = pricedModelId(args?.model, VIDEO_PRICING_CNY_PER_SEC, GENERATION_TOOL_DEFAULT_MODELS.video);
      const unitPriceCny = estimateVideoCostCny(model, durationSec);
      return { kind: 'video', count: 1, unitPriceCny, totalCny: unitPriceCny, durationSec };
    }
    case 'music_generate': {
      const model = pricedModelId(args?.model, MUSIC_PRICING_CNY, GENERATION_TOOL_DEFAULT_MODELS.music);
      const unitPriceCny = estimateMusicCostCny(model);
      return { kind: 'music', count: 1, unitPriceCny, totalCny: unitPriceCny };
    }
    default:
      return null;
  }
}
