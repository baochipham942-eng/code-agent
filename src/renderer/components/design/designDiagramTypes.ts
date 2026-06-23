// 设计画布「图解层」纯数据模型 + 归一化（无 React 依赖，可单测）。
// 图解层 = 连线(connector) + freeform 形状(shape)，与 nodes 平级存 canvas.json，
// 但不进 variant spine（无 chosen/discarded/parentId 语义，是图解脚手架非生成产物）。
// 设计要点见 docs/plans/design-node-connectors.md。

/** 图解配色板（konva 画布字面色，CSS 变量够不到；与 AnnotationLayer 同例 ds-allow:viz）。 */
export const DIAGRAM_PALETTE = [
  '#64748b', // ds-allow:viz slate（默认）
  '#3b82f6', // ds-allow:viz blue
  '#10b981', // ds-allow:viz emerald
  '#f59e0b', // ds-allow:viz amber
  '#ef4444', // ds-allow:viz red
] as const;

/** 默认图解配色（板首）。 */
export const DIAGRAM_DEFAULT_COLOR = DIAGRAM_PALETTE[0];

/** 文字/便签的最大字符数（防破损 canvas.json 注入超长文本撑爆渲染）。 */
export const DIAGRAM_TEXT_MAX = 2000;

/**
 * 连线：锚到两端 nodeId，不存几何——渲染时按两端节点实时 box 算锚点，
 * 故节点移动自动跟随，无需回写。两端任一节点不存在 → 渲染层过滤（悬空保护）。
 */
export interface CanvasConnector {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** 连线上的文字标签（画用户流/流程步骤用，可选）。 */
  label?: string;
  createdAt: number;
}

/** 矩形/椭圆/便签共享的盒型几何 + 文字。 */
interface ShapeBoxBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  createdAt: number;
}

export interface RectShape extends ShapeBoxBase {
  kind: 'rect';
}
export interface EllipseShape extends ShapeBoxBase {
  kind: 'ellipse';
}
export interface StickyShape extends ShapeBoxBase {
  kind: 'sticky';
  text: string;
}
export interface TextShape {
  id: string;
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  createdAt: number;
}
export interface LineShape {
  id: string;
  kind: 'line';
  /** [x1,y1,x2,y2] 两端点（世界坐标）。 */
  points: [number, number, number, number];
  color: string;
  createdAt: number;
}

/** freeform 形状判别联合。 */
export type CanvasShape = RectShape | EllipseShape | StickyShape | TextShape | LineShape;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验 color：必须是非空字符串，否则回退默认色（防破损注入非字符串）。 */
function normalizeColor(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : DIAGRAM_DEFAULT_COLOR;
}

/** 截断文字到上限（防超长注入），非字符串回退空串。 */
function normalizeText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.length > DIAGRAM_TEXT_MAX ? v.slice(0, DIAGRAM_TEXT_MAX) : v;
}

/** 校验并归一化一条连线；非法（缺端点 id / 自环）返回 null。 */
export function normalizeConnector(raw: unknown): CanvasConnector | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.fromNodeId !== 'string' || r.fromNodeId.length === 0) return null;
  if (typeof r.toNodeId !== 'string' || r.toNodeId.length === 0) return null;
  // 自环无意义（同一节点连自己），拒绝。
  if (r.fromNodeId === r.toNodeId) return null;
  const c: CanvasConnector = {
    id: r.id,
    fromNodeId: r.fromNodeId,
    toNodeId: r.toNodeId,
    createdAt: isFiniteNumber(r.createdAt) ? r.createdAt : 0,
  };
  if (typeof r.label === 'string' && r.label.length > 0) c.label = normalizeText(r.label);
  return c;
}

/** 校验并归一化一个形状；非法返回 null（由调用方过滤）。 */
export function normalizeShape(raw: unknown): CanvasShape | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  const createdAt = isFiniteNumber(r.createdAt) ? r.createdAt : 0;
  const color = normalizeColor(r.color);

  switch (r.kind) {
    case 'rect':
    case 'ellipse':
    case 'sticky': {
      if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
      const box: ShapeBoxBase = {
        id: r.id,
        x: r.x as number,
        y: r.y as number,
        width: r.width as number,
        height: r.height as number,
        color,
        createdAt,
      };
      if (r.kind === 'sticky') return { ...box, kind: 'sticky', text: normalizeText(r.text) };
      return { ...box, kind: r.kind };
    }
    case 'text': {
      if (![r.x, r.y].every(isFiniteNumber)) return null;
      return {
        id: r.id,
        kind: 'text',
        x: r.x as number,
        y: r.y as number,
        text: normalizeText(r.text),
        color,
        createdAt,
      };
    }
    case 'line': {
      if (!Array.isArray(r.points) || r.points.length !== 4 || !r.points.every(isFiniteNumber)) return null;
      return {
        id: r.id,
        kind: 'line',
        points: [r.points[0], r.points[1], r.points[2], r.points[3]] as [number, number, number, number],
        color,
        createdAt,
      };
    }
    default:
      return null;
  }
}

/**
 * 过滤悬空连线：两端 nodeId 必须都在 nodeIds 集合内，否则丢弃。
 * 反序列化（节点已删）与渲染时共用，保证连线永远挂在真实节点上。
 */
export function pruneDanglingConnectors(
  connectors: readonly CanvasConnector[],
  nodeIds: ReadonlySet<string>,
): CanvasConnector[] {
  return connectors.filter((c) => nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId));
}
