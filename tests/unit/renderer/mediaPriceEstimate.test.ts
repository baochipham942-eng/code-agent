import { describe, expect, it } from 'vitest';
import { estimateMediaPriceCny } from '../../../src/renderer/components/PermissionDialog/mediaPriceEstimate';
import {
  GENERATION_TOOL_DEFAULT_MODELS,
  GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
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

  it('video：无 duration 用默认 6 秒；显式 duration 按每秒单价 × 时长', () => {
    const perCall = estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC);
    expect(estimateMediaPriceCny('video_generate', { prompt: 'x' })).toEqual({
      kind: 'video',
      count: 1,
      unitPriceCny: perCall,
      totalCny: perCall,
      durationSec: GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
    });
    expect(estimateMediaPriceCny('video_generate', { prompt: 'x', duration: 10 })?.totalCny)
      .toBe(estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, 10));
  });

  it('video：cogvideox-* 不在价表 → 回落默认模型参考价（保守高估，说「参考」）', () => {
    const estimate = estimateMediaPriceCny('video_generate', { prompt: 'x', model: 'cogvideox-3', duration: 5 });
    expect(estimate?.unitPriceCny).toBe(estimateVideoCostCny(GENERATION_TOOL_DEFAULT_MODELS.video, 5));
  });

  it('music：schema 默认 id minimax-music-2.6 不是价表 key → 按真实 model 名 music-2.6 查价', () => {
    const expected = estimateMusicCostCny(GENERATION_TOOL_DEFAULT_MODELS.music);
    expect(estimateMediaPriceCny('music_generate', { prompt: 'x' })?.totalCny).toBe(expected);
    expect(estimateMediaPriceCny('music_generate', { prompt: 'x', model: 'minimax-music-2.6' })?.totalCny).toBe(expected);
  });
});
