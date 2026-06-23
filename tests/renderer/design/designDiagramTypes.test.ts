import { describe, expect, it } from 'vitest';
import {
  normalizeConnector,
  normalizeShape,
  pruneDanglingConnectors,
  DIAGRAM_DEFAULT_COLOR,
  DIAGRAM_TEXT_MAX,
  type CanvasConnector,
} from '../../../src/renderer/components/design/designDiagramTypes';

describe('normalizeConnector', () => {
  it('合法连线保留 + label', () => {
    const c = normalizeConnector({ id: 'c1', fromNodeId: 'a', toNodeId: 'b', label: '提交', createdAt: 5 });
    expect(c).toEqual({ id: 'c1', fromNodeId: 'a', toNodeId: 'b', label: '提交', createdAt: 5 });
  });

  it('缺端点 id → null', () => {
    expect(normalizeConnector({ id: 'c1', fromNodeId: 'a', createdAt: 1 })).toBeNull();
    expect(normalizeConnector({ id: 'c1', toNodeId: 'b', createdAt: 1 })).toBeNull();
    expect(normalizeConnector({ fromNodeId: 'a', toNodeId: 'b' })).toBeNull();
  });

  it('自环（from==to）拒绝', () => {
    expect(normalizeConnector({ id: 'c1', fromNodeId: 'a', toNodeId: 'a' })).toBeNull();
  });

  it('createdAt 缺失/非法 → 0；label 空串不落', () => {
    const c = normalizeConnector({ id: 'c1', fromNodeId: 'a', toNodeId: 'b', label: '' });
    expect(c?.createdAt).toBe(0);
    expect(c?.label).toBeUndefined();
  });

  it('超长 label 截断到上限', () => {
    const long = 'x'.repeat(DIAGRAM_TEXT_MAX + 500);
    const c = normalizeConnector({ id: 'c1', fromNodeId: 'a', toNodeId: 'b', label: long });
    expect(c?.label?.length).toBe(DIAGRAM_TEXT_MAX);
  });

  it('非对象 → null', () => {
    expect(normalizeConnector(null)).toBeNull();
    expect(normalizeConnector('x')).toBeNull();
  });
});

describe('normalizeShape', () => {
  it('rect 盒型几何 + 默认色', () => {
    const s = normalizeShape({ id: 's1', kind: 'rect', x: 1, y: 2, width: 30, height: 40, createdAt: 7 });
    expect(s).toEqual({
      id: 's1',
      kind: 'rect',
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      color: DIAGRAM_DEFAULT_COLOR,
      createdAt: 7,
    });
  });

  it('ellipse 保留传入色', () => {
    const s = normalizeShape({ id: 's1', kind: 'ellipse', x: 0, y: 0, width: 10, height: 10, color: '#3b82f6' });
    expect(s?.kind).toBe('ellipse');
    expect((s as { color: string }).color).toBe('#3b82f6');
  });

  it('sticky 带文字（截断）', () => {
    const s = normalizeShape({
      id: 's1',
      kind: 'sticky',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      text: 'y'.repeat(DIAGRAM_TEXT_MAX + 10),
    });
    expect(s?.kind).toBe('sticky');
    expect((s as { text: string }).text.length).toBe(DIAGRAM_TEXT_MAX);
  });

  it('text 仅需 x/y/text', () => {
    const s = normalizeShape({ id: 's1', kind: 'text', x: 5, y: 6, text: '标题', color: '#ef4444' });
    expect(s).toEqual({ id: 's1', kind: 'text', x: 5, y: 6, text: '标题', color: '#ef4444', createdAt: 0 });
  });

  it('line 需要 4 个有限数点', () => {
    const s = normalizeShape({ id: 's1', kind: 'line', points: [0, 0, 10, 10] });
    expect(s?.kind).toBe('line');
    expect((s as { points: number[] }).points).toEqual([0, 0, 10, 10]);
  });

  it('line points 长度非 4 → null', () => {
    expect(normalizeShape({ id: 's1', kind: 'line', points: [0, 0, 10] })).toBeNull();
    expect(normalizeShape({ id: 's1', kind: 'line', points: [0, 0, 'x', 10] })).toBeNull();
  });

  it('盒型缺/非数字几何 → null', () => {
    expect(normalizeShape({ id: 's1', kind: 'rect', x: 0, y: 0, width: 'NaN', height: 1 })).toBeNull();
  });

  it('缺 id / 未知 kind → null', () => {
    expect(normalizeShape({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(normalizeShape({ id: 's1', kind: 'star', x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });

  it('color 非字符串 → 回退默认色', () => {
    const s = normalizeShape({ id: 's1', kind: 'rect', x: 0, y: 0, width: 1, height: 1, color: 123 });
    expect((s as { color: string }).color).toBe(DIAGRAM_DEFAULT_COLOR);
  });
});

describe('pruneDanglingConnectors', () => {
  const conn = (over: Partial<CanvasConnector>): CanvasConnector => ({
    id: 'c',
    fromNodeId: 'a',
    toNodeId: 'b',
    createdAt: 0,
    ...over,
  });

  it('两端都在 → 保留', () => {
    const out = pruneDanglingConnectors([conn({})], new Set(['a', 'b']));
    expect(out).toHaveLength(1);
  });

  it('任一端缺失 → 丢弃', () => {
    expect(pruneDanglingConnectors([conn({})], new Set(['a']))).toHaveLength(0);
    expect(pruneDanglingConnectors([conn({})], new Set(['b']))).toHaveLength(0);
    expect(pruneDanglingConnectors([conn({})], new Set())).toHaveLength(0);
  });
});
