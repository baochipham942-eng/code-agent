// 画布栏顶部遮挡的矩形相交检测（纯几何，无 DOM）。
// 背景：elementFromPoint 命中测试对 pointer-events:none 的纯文本天生失明——文本被可点元素
// 压住时，命中测试返回的是文本底下的元素，探针照样全绿（2026-08-01 引导文字被「导出 PPTX」
// 压住半句就是这么漏过去的）。本模块是并列的第二种检测口径：
// 顶部区域内文本元素 × 可点元素两两 bounding box 相交判定，相交即判失败。
// 探针（docs/plans/assets/2026-08-01-画布栏宽度探针.mjs）在页面内收集 rect 后调这里判定；
// tests/unit/scripts/designTopbarOcclusion.test.ts 守判定语义。

export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcclusionItem {
  name: string;
  rect: OcclusionRect;
}

export interface OcclusionCollision {
  text: string;
  clickable: string;
  overlapWidth: number;
  overlapHeight: number;
}

const isZeroSize = (r: OcclusionRect): boolean => r.width <= 0 || r.height <= 0;

// 正面积相交才算重叠：边缘相贴（共边/共点）不算遮挡，零尺寸矩形不参与。
export function rectsIntersect(a: OcclusionRect, b: OcclusionRect): boolean {
  return overlapSize(a, b) !== null;
}

export function overlapSize(
  a: OcclusionRect,
  b: OcclusionRect,
): { width: number; height: number } | null {
  if (isZeroSize(a) || isZeroSize(b)) return null;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// 文本 × 可点两两判定：只报跨组碰撞（text×clickable），同组相交（text×text / clickable×clickable）
// 不在本口径内。调用方负责预先剔除「按钮自家 label」这类包含关系（DOM 侧 contains 判断）。
export function findTextClickableCollisions(
  texts: OcclusionItem[],
  clickables: OcclusionItem[],
): OcclusionCollision[] {
  const collisions: OcclusionCollision[] = [];
  for (const text of texts) {
    if (isZeroSize(text.rect)) continue;
    for (const clickable of clickables) {
      const overlap = overlapSize(text.rect, clickable.rect);
      if (!overlap) continue;
      collisions.push({
        text: text.name,
        clickable: clickable.name,
        overlapWidth: Math.round(overlap.width),
        overlapHeight: Math.round(overlap.height),
      });
    }
  }
  return collisions;
}
