// 圈选标注 → inpaint mask 工具。
// 纯坐标映射（worldRectToImageRegion）可单测；DOM 栅格化（buildMaskDataUrl）依赖 canvas。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 画布上一个图节点的世界坐标矩形（= 自然像素，node.width/height 取自图原始尺寸）。 */
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把世界坐标的红框与某图节点求交，转成「图内局部像素矩形」（mask 用）。
 * 无重叠返回 null。node 的 width/height 即图原始像素，世界坐标按 1:1 对应图像素。
 */
export function worldRectToImageRegion(rect: Rect, node: NodeBox): Rect | null {
  const left = Math.max(rect.x, node.x);
  const top = Math.max(rect.y, node.y);
  const right = Math.min(rect.x + rect.width, node.x + node.width);
  const bottom = Math.min(rect.y + rect.height, node.y + node.height);
  if (right <= left || bottom <= top) return null;
  return { x: left - node.x, y: top - node.y, width: right - left, height: bottom - top };
}

/** 归一化一个由起点/终点定义的拖拽框（支持反向拖拽），返回左上+正宽高。 */
export function normalizeDragRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/**
 * 生成 inpaint mask 的 base64 dataURL：黑底 + 白色编辑区（通义万相约定 白=改/黑=留）。
 * 依赖 DOM canvas，运行在 renderer。
 */
export function buildMaskDataUrl(width: number, height: number, regions: readonly Rect[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 mask canvas 上下文');
  ctx.fillStyle = '#000000'; // ds-allow:viz konva 画布字面色，CSS 变量够不到
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff'; // ds-allow:viz konva 画布字面色，CSS 变量够不到
  for (const r of regions) {
    ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
  }
  return canvas.toDataURL('image/png');
}
