// 面板 stage CSS 尺寸 → 托管浏览器视口 + 帧采集分辨率（浏览器三期 R4 F1/F2）。
// 视口用 CSS px（Playwright mouse 坐标同单位）；采集用 CSS × devicePixelRatio 封顶。

import { BROWSER_STAGE_VIEWPORT } from '../constants';

export interface StageCssSize {
  width: number;
  height: number;
}

export interface StageFollowViewport {
  width: number;
  height: number;
}

export interface StageFollowCapture {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

export interface StageFollowPlan {
  viewport: StageFollowViewport;
  capture: StageFollowCapture;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 将 stage 的 CSS 尺寸钳到合法视口范围（取整）。
 * 非法尺寸返回 null（调用方应跳过本次跟随）。
 */
export function resolveStageFollowViewport(stage: StageCssSize): StageFollowViewport | null {
  if (!finitePositive(stage.width) || !finitePositive(stage.height)) return null;
  const width = Math.round(stage.width);
  const height = Math.round(stage.height);
  if (width < 1 || height < 1) return null;
  return {
    width: Math.min(
      BROWSER_STAGE_VIEWPORT.MAX_CSS_WIDTH,
      Math.max(BROWSER_STAGE_VIEWPORT.MIN_CSS_WIDTH, width),
    ),
    height: Math.min(
      BROWSER_STAGE_VIEWPORT.MAX_CSS_HEIGHT,
      Math.max(BROWSER_STAGE_VIEWPORT.MIN_CSS_HEIGHT, height),
    ),
  };
}

/**
 * 帧采集物理分辨率 = 视口 CSS × dpr，封顶 CAPTURE_MAX_*。
 * dpr 非法或 ≤0 时按 1 处理。
 */
export function resolveStageFollowCapture(
  viewport: StageFollowViewport,
  devicePixelRatio: number,
): StageFollowCapture {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const rawW = Math.round(viewport.width * dpr);
  const rawH = Math.round(viewport.height * dpr);
  const maxW = BROWSER_STAGE_VIEWPORT.CAPTURE_MAX_WIDTH;
  const maxH = BROWSER_STAGE_VIEWPORT.CAPTURE_MAX_HEIGHT;
  // 等比压到封顶：优先保宽高比，避免片面压扁。
  const scale = Math.min(1, maxW / Math.max(1, rawW), maxH / Math.max(1, rawH));
  return {
    maxWidth: Math.max(1, Math.round(rawW * scale)),
    maxHeight: Math.max(1, Math.round(rawH * scale)),
    quality: BROWSER_STAGE_VIEWPORT.JPEG_QUALITY,
  };
}

/** 一次算完视口 + 采集计划。 */
export function resolveStageFollowPlan(
  stage: StageCssSize,
  devicePixelRatio: number,
): StageFollowPlan | null {
  const viewport = resolveStageFollowViewport(stage);
  if (!viewport) return null;
  return {
    viewport,
    capture: resolveStageFollowCapture(viewport, devicePixelRatio),
  };
}

/**
 * 视口跟随后：stage 显示区与内容同尺寸时，点击点应 1:1 映射（无 letterbox）。
 * 供单测/变异断言；实现上 content 取视口 CSS，display 取 stage 量测。
 */
export function mapStagePointAfterViewportFollow(
  point: { x: number; y: number },
  stage: StageCssSize,
  viewport: StageFollowViewport,
): { x: number; y: number } | null {
  if (
    !finitePositive(stage.width)
    || !finitePositive(stage.height)
    || !finitePositive(viewport.width)
    || !finitePositive(viewport.height)
  ) {
    return null;
  }
  if (
    point.x < 0 || point.y < 0
    || point.x > stage.width
    || point.y > stage.height
  ) {
    return null;
  }
  // 跟随成功后 content 与 display 等比铺满：用相对比例映射到视口 CSS。
  return {
    x: (point.x / stage.width) * viewport.width,
    y: (point.y / stage.height) * viewport.height,
  };
}
