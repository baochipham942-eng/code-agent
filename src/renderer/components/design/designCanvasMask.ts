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

// —— 标注 → inpaint mask（2026-08-01 B1）——————————————————————————————
// 背景：标注重绘原先把红线**烧进原图**当参考图发给模型。2026-08-01 付费 A/B 实测证明这条路
// 是错的——红箭头与红文字被模型当成画面内容照抄进成品，红圈还被当成「要画成圆形」的形状提示；
// 加提示词前缀（「红色是批注不是内容」）**不能**解决，两臂都留着标注痕迹。
//
// 正解：底图传**干净原图**（没有红线可抄）+ mask 说清楚「改哪里」+ 指令说清楚「改成什么」。
// 走的是已有的 description_edit_with_mask 通道，附带 T4 一致性锁定（未标注区域逐像素不变）。

import type { AnnotShape } from './AnnotationLayer';

/** mask 几何：text 不进 mask（它是标签不是区域），文字内容随指令走。 */
export interface AnnotMaskGeometry {
  /** 自由笔画折线 [x0,y0,x1,y1,...]，按笔宽描粗后进 mask。 */
  polylines: number[][];
  /** 整块填充的矩形。 */
  rects: Rect[];
  /** 以点为圆心填充的圆——箭头**指向的目标**（不是整条杆）。 */
  points: Array<{ x: number; y: number }>;
  /** text 标注的文字，供调用方拼进指令（不进 mask）。 */
  labels: string[];
}

/**
 * 标注笔画在 mask 上的加粗半径（按图短边取，最小 12px）。
 * 用户画的是「指一下」的细线（lineWidth 写死 3），直接拿它当重绘区域会窄到模型无从下笔，
 * 必须加粗成一条有面积的带子。
 */
export function annotBrushRadius(width: number, height: number): number {
  return Math.max(12, Math.round(Math.min(width, height) * 0.03));
}

/** 把标注形状拆成 mask 几何。纯函数，可单测（不碰 DOM）。 */
export function annotShapesToMaskGeometry(shapes: readonly AnnotShape[]): AnnotMaskGeometry {
  const geo: AnnotMaskGeometry = { polylines: [], rects: [], points: [], labels: [] };
  for (const s of shapes) {
    switch (s.kind) {
      case 'pen':
        if (s.points.length >= 2) geo.polylines.push([...s.points]);
        break;
      case 'rect': {
        // 支持反向拖拽出来的负宽高。
        const r = normalizeDragRect(s.x, s.y, s.x + s.w, s.y + s.h);
        if (r.width > 0 && r.height > 0) geo.rects.push(r);
        break;
      }
      case 'arrow':
        // 只取箭头**末端**（用户指的那个点）。整条杆进 mask 会在画面上重绘出一道斜的长条。
        geo.points.push({ x: s.points[2], y: s.points[3] });
        break;
      case 'text':
        if (s.text.trim()) geo.labels.push(s.text.trim());
        break;
    }
  }
  return geo;
}

/** mask 有没有实际可重绘的面积。全空时必须拦下——否则是一次「改了个寂寞」的付费调用。 */
export function hasMaskArea(geo: AnnotMaskGeometry): boolean {
  return geo.polylines.length > 0 || geo.rects.length > 0 || geo.points.length > 0;
}

/**
 * 由标注几何栅格化 inpaint mask（黑=留 / 白=改，与 buildMaskDataUrl 同约定）。
 * 依赖 DOM canvas，运行在 renderer。
 */
export function buildAnnotMaskDataUrl(width: number, height: number, geo: AnnotMaskGeometry): string {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 mask canvas 上下文');
  ctx.fillStyle = '#000000'; // ds-allow:viz mask 位图字面色，CSS 变量够不到
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const r = annotBrushRadius(canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff'; // ds-allow:viz mask 位图字面色
  ctx.strokeStyle = '#ffffff'; // ds-allow:viz mask 位图字面色
  ctx.lineWidth = r * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const rect of geo.rects) {
    ctx.fillRect(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
  }
  for (const pts of geo.polylines) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    // 单点笔画（点一下没拖动）描边画不出东西，补一个圆点。
    if (pts.length < 4) ctx.lineTo(pts[0] + 0.01, pts[1]);
    ctx.stroke();
  }
  for (const p of geo.points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}
