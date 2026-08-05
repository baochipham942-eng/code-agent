import { describe, expect, it } from 'vitest';
import { BROWSER_STAGE_VIEWPORT } from '../../../src/shared/constants';
import {
  mapStagePointAfterViewportFollow,
  resolveStageFollowCapture,
  resolveStageFollowPlan,
  resolveStageFollowViewport,
} from '../../../src/shared/utils/browserStageViewportFollow';
import { mapDisplayPointToViewport } from '../../../src/shared/utils/browserFrameCoordinateMap';

describe('browserStageViewportFollow（R4 视口跟随）', () => {
  it('stage CSS 钳到合法视口，非法尺寸返回 null', () => {
    expect(resolveStageFollowViewport({ width: 900.4, height: 500.6 })).toEqual({
      width: 900,
      height: 501,
    });
    expect(resolveStageFollowViewport({ width: 0, height: 400 })).toBeNull();
    expect(resolveStageFollowViewport({ width: -1, height: 400 })).toBeNull();
    // 过小抬到 MIN
    expect(resolveStageFollowViewport({ width: 10, height: 10 })).toEqual({
      width: BROWSER_STAGE_VIEWPORT.MIN_CSS_WIDTH,
      height: BROWSER_STAGE_VIEWPORT.MIN_CSS_HEIGHT,
    });
  });

  it('采集分辨率 = CSS × dpr，封顶 CAPTURE_MAX_WIDTH', () => {
    const viewport = { width: 1000, height: 600 };
    const cap1 = resolveStageFollowCapture(viewport, 1);
    expect(cap1.maxWidth).toBe(1000);
    expect(cap1.maxHeight).toBe(600);
    expect(cap1.quality).toBe(BROWSER_STAGE_VIEWPORT.JPEG_QUALITY);

    const cap2 = resolveStageFollowCapture(viewport, 2);
    expect(cap2.maxWidth).toBe(2000);
    expect(cap2.maxHeight).toBe(1200);

    // 超宽封顶
    const wide = resolveStageFollowCapture({ width: 2000, height: 1000 }, 2);
    expect(wide.maxWidth).toBeLessThanOrEqual(BROWSER_STAGE_VIEWPORT.CAPTURE_MAX_WIDTH);
    expect(wide.maxHeight).toBeLessThanOrEqual(BROWSER_STAGE_VIEWPORT.CAPTURE_MAX_HEIGHT);
    // 等比
    expect(wide.maxWidth / wide.maxHeight).toBeCloseTo(2, 1);
  });

  it('视口变更后坐标映射仍准确（content 跟新视口）', () => {
    // 初始 16:9 视口在非 16:9 面板会 letterbox；跟随后 content=stage 无灰边、1:1 映射
    const stage = { width: 800, height: 500 };
    const oldContent = { width: 1280, height: 720 };
    const followed = resolveStageFollowViewport(stage)!;
    expect(followed).toEqual({ width: 800, height: 500 });

    const point = { x: 400, y: 250 };
    // 旧：object-contain letterbox 映射
    const before = mapDisplayPointToViewport(point, stage, oldContent);
    // 新：content = 视口 CSS = stage
    const afterContain = mapDisplayPointToViewport(point, stage, followed);
    const afterFollowHelper = mapStagePointAfterViewportFollow(point, stage, followed);

    expect(afterContain).toEqual({ x: 400, y: 250 });
    expect(afterFollowHelper).toEqual({ x: 400, y: 250 });
    // 若仍用旧 1280×720 内容尺寸，中心点不会是 (400,250)
    expect(before).not.toEqual(afterContain);
  });

  // 变异 1：若采集忘记乘 dpr，Retina 仍会糊（分辨率停在 CSS 档）
  it('变异防护：漏乘 dpr 会使 capture 停在 CSS 尺寸', () => {
    const viewport = { width: 900, height: 500 };
    const correct = resolveStageFollowCapture(viewport, 2);
    const buggy = {
      maxWidth: viewport.width,
      maxHeight: viewport.height,
    };
    expect(correct.maxWidth).toBe(1800);
    expect(buggy.maxWidth).toBe(900);
    expect(buggy.maxWidth).not.toBe(correct.maxWidth);
  });

  // 变异 2：视口变更后仍用旧 contentWidth 做映射 → 落点偏移
  it('变异防护：视口变更后仍用旧 content 映射会偏离真实点击', () => {
    const stage = { width: 600, height: 400 };
    const oldContent = { width: 1280, height: 720 };
    const newContent = resolveStageFollowViewport(stage)!;
    const point = { x: 100, y: 100 };
    const stale = mapDisplayPointToViewport(point, stage, oldContent);
    const fresh = mapDisplayPointToViewport(point, stage, newContent);
    expect(fresh).toEqual({ x: 100, y: 100 });
    expect(stale).not.toBeNull();
    expect(stale!.x).not.toBeCloseTo(fresh!.x, 0);
  });

  it('resolveStageFollowPlan 一次给出视口+采集', () => {
    const plan = resolveStageFollowPlan({ width: 640, height: 360 }, 2);
    expect(plan?.viewport).toEqual({ width: 640, height: 360 });
    expect(plan?.capture.maxWidth).toBe(1280);
    expect(plan?.capture.maxHeight).toBe(720);
  });
});
