// 图解形状绘制纯归约器（无 konva 依赖，可单测；照搬 AnnotationLayer.reduceAnnot 的
// down/move/up 不可变归约模式）。区别：图解形状可落盘，故 id/createdAt/color 由 down 事件
// 携带（组件用 crypto.randomUUID + Date.now 注入），保持归约器纯函数、测试确定。
import type { CanvasShape } from './designDiagramTypes';

/** 可绘制的形状工具（text 为点击即落，其余 down→move→up 拖拽）。 */
export type ShapeTool = 'rect' | 'ellipse' | 'sticky' | 'line' | 'text';

export type DiagramDrawEvent =
  | { type: 'down'; tool: ShapeTool; x: number; y: number; id: string; createdAt: number; color: string; text?: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'up' };

/** 盒型最小边长：down→up 位移小于此视为误点，up 时丢弃（防一点击落一堆零尺寸形状）。 */
export const MIN_SHAPE_SIZE = 3;

/** 判断盒型形状是否退化（宽高都过小）。 */
function isDegenerateBox(s: CanvasShape): boolean {
  if (s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'sticky') {
    return Math.abs(s.width) < MIN_SHAPE_SIZE && Math.abs(s.height) < MIN_SHAPE_SIZE;
  }
  if (s.kind === 'line') {
    const [x1, y1, x2, y2] = s.points;
    return Math.abs(x2 - x1) < MIN_SHAPE_SIZE && Math.abs(y2 - y1) < MIN_SHAPE_SIZE;
  }
  return false;
}

/** 把负宽高的盒型归一化为左上角 + 正宽高（拖拽支持反向，落盘前摆正）。 */
export function normalizeShapeBox(s: CanvasShape): CanvasShape {
  if (s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'sticky') {
    const x = s.width < 0 ? s.x + s.width : s.x;
    const y = s.height < 0 ? s.y + s.height : s.y;
    return { ...s, x, y, width: Math.abs(s.width), height: Math.abs(s.height) };
  }
  return s;
}

/**
 * 把单个绘制事件归约进 shapes 数组（不可变，永远返回新数组）。
 * - down：rect/ellipse/sticky 推零尺寸盒；line 推零长线；text 立即落定。
 * - move：更新最后一个"进行中"形状（替换末尾）。
 * - up：盒型/线摆正负宽高；退化（误点）丢弃。
 */
export function reduceDiagram(shapes: CanvasShape[], evt: DiagramDrawEvent): CanvasShape[] {
  switch (evt.type) {
    case 'down': {
      const { id, createdAt, color } = evt;
      switch (evt.tool) {
        case 'rect':
          return [...shapes, { id, kind: 'rect', x: evt.x, y: evt.y, width: 0, height: 0, color, createdAt }];
        case 'ellipse':
          return [...shapes, { id, kind: 'ellipse', x: evt.x, y: evt.y, width: 0, height: 0, color, createdAt }];
        case 'sticky':
          return [
            ...shapes,
            { id, kind: 'sticky', x: evt.x, y: evt.y, width: 0, height: 0, color, createdAt, text: evt.text ?? '' },
          ];
        case 'line':
          return [...shapes, { id, kind: 'line', points: [evt.x, evt.y, evt.x, evt.y], color, createdAt }];
        case 'text':
          return [...shapes, { id, kind: 'text', x: evt.x, y: evt.y, text: evt.text ?? '', color, createdAt }];
        default:
          return shapes;
      }
    }
    case 'move': {
      if (shapes.length === 0) return shapes;
      const last = shapes[shapes.length - 1];
      const head = shapes.slice(0, -1);
      switch (last.kind) {
        case 'rect':
        case 'ellipse':
        case 'sticky':
          return [...head, { ...last, width: evt.x - last.x, height: evt.y - last.y }];
        case 'line':
          return [...head, { ...last, points: [last.points[0], last.points[1], evt.x, evt.y] }];
        case 'text':
          // text 已落定，move 不更新。
          return shapes;
        default:
          return shapes;
      }
    }
    case 'up': {
      if (shapes.length === 0) return shapes;
      const last = shapes[shapes.length - 1];
      // text 无拖拽阶段，原样保留。
      if (last.kind === 'text') return shapes;
      if (isDegenerateBox(last)) return shapes.slice(0, -1); // 误点丢弃
      return [...shapes.slice(0, -1), normalizeShapeBox(last)];
    }
    default:
      return shapes;
  }
}
