import { describe, expect, it } from 'vitest';
import {
  reduceAnnot,
  ANNOT_COLOR,
  type AnnotShape,
} from '../../../src/renderer/components/design/AnnotationLayer';

describe('reduceAnnot 纯归约器', () => {
  it('画笔：down→move→up 得到一条 pen', () => {
    let s: AnnotShape[] = [];
    s = reduceAnnot(s, { type: 'down', tool: 'pen', x: 1, y: 1 });
    s = reduceAnnot(s, { type: 'move', x: 2, y: 2 });
    s = reduceAnnot(s, { type: 'up' });
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('pen');
    expect((s[0] as any).points).toEqual([1, 1, 2, 2]);
    expect((s[0] as any).color).toBe(ANNOT_COLOR);
  });
  it('矩形：down→move→up 得到 rect(w/h)', () => {
    let s: AnnotShape[] = [];
    s = reduceAnnot(s, { type: 'down', tool: 'rect', x: 0, y: 0 });
    s = reduceAnnot(s, { type: 'move', x: 10, y: 20 });
    s = reduceAnnot(s, { type: 'up' });
    expect(s[0]).toMatchObject({ kind: 'rect', x: 0, y: 0, w: 10, h: 20 });
  });
  it('箭头：down→move→up 得到 arrow(points 4)', () => {
    let s: AnnotShape[] = [];
    s = reduceAnnot(s, { type: 'down', tool: 'arrow', x: 0, y: 0 });
    s = reduceAnnot(s, { type: 'move', x: 5, y: 6 });
    s = reduceAnnot(s, { type: 'up' });
    expect(s[0]).toMatchObject({ kind: 'arrow', points: [0, 0, 5, 6] });
  });
  it('文字：down 立即落定一个 text', () => {
    let s: AnnotShape[] = [];
    s = reduceAnnot(s, { type: 'down', tool: 'text', x: 3, y: 4, text: '改这里' });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'text', x: 3, y: 4, text: '改这里' });
  });
  it('不可变：不改输入数组', () => {
    const s0: AnnotShape[] = [];
    const s1 = reduceAnnot(s0, { type: 'down', tool: 'pen', x: 0, y: 0 });
    expect(s0).toHaveLength(0);
    expect(s1).not.toBe(s0);
  });
});
