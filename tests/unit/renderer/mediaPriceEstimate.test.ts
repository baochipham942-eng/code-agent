import { describe, expect, it } from 'vitest';
import { estimateMediaPriceCny } from '../../../src/renderer/components/PermissionDialog/mediaPriceEstimate';
import {
  GENERATION_TOOL_DEFAULT_MODELS,
  GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
  GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC,
} from '../../../src/shared/media/generationToolDefaults';
import { estimateImageCostCny } from '../../../src/shared/media/imageCost';
import { estimateMusicCostCny } from '../../../src/shared/media/musicCost';
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';

// N-MEDIA-GEN-PRICE-CARD：纯函数口径——数量/时长/模型回退规则，价格数字与成本函数相等。

describe('estimateMediaPriceCny（审批卡参考价纯函数）', () => {
  it('非付费生成工具一律 null', () => {
    for (const tool of ['http_request', 'web_fetch', 'mcp', 'Bash', 'image_annotate']) {
      expect(estimateMediaPriceCny(tool, { prompt: ['x'] }), tool).toBeNull();
    }
    expect(estimateMediaPriceCny('image_generate', undefined)).toBeNull();
  });

  it('image：prompt 数组按条数计价，字符串按 1 张，空数组/缺失为 null', () => {
    const unit = estimateImageCostCny(GENERATION_TOOL_DEFAULT_MODELS.image);
    expect(estimateMediaPriceCny('image_generate', { prompt: ['a', 'b', 'c'] })).toEqual({
      kind: 'image',
      count: 3,
      unitPriceCny: unit,
      totalCny: unit * 3,
    });
    expect(estimateMediaPriceCny('image_generate', { prompt: 'a' })?.count).toBe(1);
    expect(estimateMediaPriceCny('image_generate', { prompt: [] })).toBeNull();
    expect(estimateMediaPriceCny('image_generate', {})).toBeNull();
  });

  it('image：model 只有命中价表才认，未知 id 回落工具默认模型（CogView）', () => {
    const defaultUnit = estimateImageCostCny(GENERATION_TOOL_DEFAULT_MODELS.image);
    expect(estimateMediaPriceCny('image_generate', { prompt: 'a', model: 'wanx2.1-t2i-turbo' })?.unitPriceCny)
      .toBe(estimateImageCostCny('wanx2.1-t2i-turbo'));
    expect(estimateMediaPriceCny('image_generate', { prompt: 'a', model: 'totally-unknown-model' })?.unitPriceCny)
      .toBe(defaultUnit);
  });

  it('video：默认路由无 duration 用默认 6 秒', () => {
    const perCall = estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC);
    expect(estimateMediaPriceCny('video_generate', { prompt: 'x' })).toEqual({
      kind: 'video',
      count: 1,
      unitPriceCny: perCall,
      totalCny: perCall,
      durationSec: GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
    });
  });

  // ai-review 返修：duration 只有 cogvideox-* 路由真正生效——host 在默认 MiniMax 海螺路由
  // 不把 duration 传给 provider（videoGenerate.ts 的 generateVideo 调用不带 durationSec，
  // videoGenerationService.ts 海螺 body 也不含 duration，固定 6 秒），schema 同文。卡片
  // 若采信 args.duration，模型传 {prompt, duration:10} 时会显示「10 秒 / ¥4.20」而实际
  // 出 6 秒片计约 ¥2.52——时长与价格双错。回归断言：默认路由忽略 duration，恒 6 秒。
  it('video：默认路由（含显式海螺 model）忽略 args.duration，恒默认 6 秒', () => {
    expect(estimateMediaPriceCny('video_generate', { prompt: 'x', duration: 10 })).toEqual({
      kind: 'video',
      count: 1,
      unitPriceCny: estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC),
      totalCny: estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC),
      durationSec: GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
    });
    expect(estimateMediaPriceCny('video_generate', { prompt: 'x', model: 'MiniMax-Hailuo-02', duration: 10 })?.durationSec)
      .toBe(GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC);
  });

  it('video：cogvideox-* 不在价表 → 回落默认模型参考价（保守高估，说「参考」）；duration 仅此路由生效', () => {
    const estimate = estimateMediaPriceCny('video_generate', { prompt: 'x', model: 'cogvideox-3', duration: 5 });
    expect(estimate?.unitPriceCny).toBe(estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, 5));
    // cogvideox 缺 duration：host 传 params.duration || 5 给智谱，缺省按 5 秒估（不是海螺的 6）。
    const noDuration = estimateMediaPriceCny('video_generate', { prompt: 'x', model: 'cogvideox-3' });
    expect(noDuration?.durationSec).toBe(GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC);
    expect(noDuration?.unitPriceCny)
      .toBe(estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC));
  });

  it('music：schema 默认 id minimax-music-2.6 不是价表 key → 按真实 model 名 music-2.6 查价', () => {
    const expected = estimateMusicCostCny(GENERATION_TOOL_DEFAULT_MODELS.music);
    expect(estimateMediaPriceCny('music_generate', { prompt: 'x' })?.totalCny).toBe(expected);
    expect(estimateMediaPriceCny('music_generate', { prompt: 'x', model: 'minimax-music-2.6' })?.totalCny).toBe(expected);
  });

  // ai-review r1 返修回归：MUSIC_PRICING_CNY 曾是「价表待补」占位 ¥0.2/首，比 musicGenerate.schema
  // 同源引用的 MiniMax 官方价目 $0.15/首低约 5 倍且方向为低估——审批卡据低估价误导付费决策。
  // 锚定官方价折算：$0.15 × 7.2（仓内 USD→CNY 口径，见 pricing.ts Veo 注释）≈ ¥1.08/首。
  it('music：music-2.6 参考价锚定官方价 $0.15/首 × 7.2 ≈ ¥1.08，不得回落占位 ¥0.2', () => {
    expect(estimateMusicCostCny(GENERATION_TOOL_DEFAULT_MODELS.music)).toBeCloseTo(0.15 * 7.2, 2);
    expect(estimateMediaPriceCny('music_generate', { prompt: 'x' })?.totalCny).toBeCloseTo(0.15 * 7.2, 2);
  });
});
