// 连线锚点几何（纯函数，可单测）。连线不存几何，渲染时按两端节点实时 box 算锚点：
// 锚点 = 两端中心连线与各自边框的交点，故节点移动时连线自动跟随、贴边不穿心。

/** 轴对齐盒（取自画布节点的 x/y/width/height）。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConnectorEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function center(b: Box): { cx: number; cy: number } {
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

/**
 * 从盒中心沿方向 (dx,dy) 求与边框的交点。
 * 半宽/半高为 0 时退化为中心点。方向为零向量时返回中心。
 */
function borderPoint(b: Box, dx: number, dy: number): { x: number; y: number } {
  const { cx, cy } = center(b);
  const hw = b.width / 2;
  const hh = b.height / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // 缩放因子 t：把方向向量推到最近的边（取 x 向与 y 向触边所需 t 的较小值）。
  const tx = hw > 0 && dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = hh > 0 && dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return { x: cx, y: cy };
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * 算两端节点之间连线的锚点端点（from 边 → to 边）。
 * 两端中心重合（节点重叠）时返回两中心（零长，渲染层可据此跳过）。
 */
export function connectorEndpoints(from: Box, to: Box): ConnectorEndpoints {
  const a = center(from);
  const b = center(to);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (dx === 0 && dy === 0) {
    return { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
  }
  const start = borderPoint(from, dx, dy); // 朝 to 出边
  const end = borderPoint(to, -dx, -dy); // 朝 from 出边
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** 连线中点（用于挂文字 label）。 */
export function connectorMidpoint(e: ConnectorEndpoints): { x: number; y: number } {
  return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
}
