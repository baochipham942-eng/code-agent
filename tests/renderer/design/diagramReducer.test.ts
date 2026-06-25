import { describe, expect, it } from 'vitest';
import {
  reduceDiagram,
  normalizeShapeBox,
  MIN_SHAPE_SIZE,
  type DiagramDrawEvent,
} from '../../../src/renderer/components/design/diagramReducer';
import type { CanvasShape } from '../../../src/renderer/components/design/designDiagramTypes';

const down = (over: Partial<Extract<DiagramDrawEvent, { type: 'down' }>>): DiagramDrawEvent => ({
  type: 'down',
  tool: 'rect',
  x: 0,
  y: 0,
  id: 'shape-1',
  createdAt: 100,
  color: '#64748b',
  ...over,
});

describe('reduceDiagram 拖拽盒型', () => {
  it('rect down→move→up：摆正 + 记录几何', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'rect', x: 10, y: 10 }));
    shapes = reduceDiagram(shapes, { type: 'move', x: 60, y: 40 });
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes).toEqual([
      { id: 'shape-1', kind: 'rect', x: 10, y: 10, width: 50, height: 30, color: '#64748b', createdAt: 100 },
    ]);
  });

  it('反向拖拽（终点在起点左上）up 后摆正为正宽高', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'ellipse', x: 100, y: 100 }));
    shapes = reduceDiagram(shapes, { type: 'move', x: 60, y: 40 });
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes[0]).toMatchObject({ kind: 'ellipse', x: 60, y: 40, width: 40, height: 60 });
  });

  it('退化盒（位移 < MIN）up 时丢弃（防误点）', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'rect', x: 5, y: 5 }));
    shapes = reduceDiagram(shapes, { type: 'move', x: 5 + MIN_SHAPE_SIZE - 1, y: 5 });
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes).toHaveLength(0);
  });

  it('sticky 携带初始文字', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'sticky', x: 0, y: 0, text: '便签' }));
    shapes = reduceDiagram(shapes, { type: 'move', x: 80, y: 80 });
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes[0]).toMatchObject({ kind: 'sticky', text: '便签', width: 80, height: 80 });
  });
});

describe('reduceDiagram line', () => {
  it('line down→move→up 记录两端', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'line', x: 0, y: 0 }));
    shapes = reduceDiagram(shapes, { type: 'move', x: 100, y: 50 });
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes[0]).toMatchObject({ kind: 'line', points: [0, 0, 100, 50] });
  });

  it('零长 line up 丢弃', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'line', x: 0, y: 0 }));
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes).toHaveLength(0);
  });
});

describe('reduceDiagram text 点击即落', () => {
  it('text down 立即落定，move 不变', () => {
    let shapes: CanvasShape[] = [];
    shapes = reduceDiagram(shapes, down({ tool: 'text', x: 20, y: 30, text: '标题' }));
    const afterDown = shapes;
    shapes = reduceDiagram(shapes, { type: 'move', x: 99, y: 99 });
    expect(shapes).toBe(afterDown); // move 对 text 无操作，返回原引用
    shapes = reduceDiagram(shapes, { type: 'up' });
    expect(shapes[0]).toEqual({ id: 'shape-1', kind: 'text', x: 20, y: 30, text: '标题', color: '#64748b', createdAt: 100 });
  });
});

describe('不可变性', () => {
  it('down 不修改入参数组', () => {
    const orig: CanvasShape[] = [];
    const out = reduceDiagram(orig, down({}));
    expect(orig).toHaveLength(0);
    expect(out).not.toBe(orig);
  });
});

describe('normalizeShapeBox', () => {
  it('line 原样返回', () => {
    const line: CanvasShape = { id: 'l', kind: 'line', points: [0, 0, 1, 1], color: '#64748b', createdAt: 0 };
    expect(normalizeShapeBox(line)).toBe(line);
  });
});
