import { describe, expect, it } from 'vitest';
import {
  annotShapesToMaskGeometry,
  hasMaskArea,
  annotBrushRadius,
} from '../../../src/renderer/components/design/designCanvasMask';
import type { AnnotShape } from '../../../src/renderer/components/design/AnnotationLayer';

const C = '#ff2d2d';

describe('annotShapesToMaskGeometry — 四种标注各自进不进 mask', () => {
  it('pen 进 polylines（原样保留点序列）', () => {
    const shapes: AnnotShape[] = [{ kind: 'pen', points: [10, 20, 30, 40, 50, 60], color: C }];
    const geo = annotShapesToMaskGeometry(shapes);
    expect(geo.polylines).toEqual([[10, 20, 30, 40, 50, 60]]);
    expect(geo.rects).toHaveLength(0);
    expect(geo.points).toHaveLength(0);
  });

  it('rect 进 rects，且支持反向拖拽（负宽高归一化）', () => {
    const geo = annotShapesToMaskGeometry([{ kind: 'rect', x: 100, y: 200, w: -60, h: -40, color: C }]);
    expect(geo.rects).toEqual([{ x: 40, y: 160, width: 60, height: 40 }]);
  });

  it('arrow 只取末端一点，不把整条杆放进 mask', () => {
    // 若把整条杆栅格化，画面上会多出一道斜的长条重绘带——这条钉死「只取箭头指的目标」。
    const geo = annotShapesToMaskGeometry([{ kind: 'arrow', points: [10, 10, 500, 400], color: C }]);
    expect(geo.points).toEqual([{ x: 500, y: 400 }]);
    expect(geo.polylines).toHaveLength(0);
    expect(geo.rects).toHaveLength(0);
  });

  it('text 不进 mask，只把文字收进 labels（标签是语义不是区域）', () => {
    const geo = annotShapesToMaskGeometry([{ kind: 'text', x: 5, y: 5, text: '  改这个  ', color: C }]);
    expect(geo.labels).toEqual(['改这个']);
    expect(geo.polylines).toHaveLength(0);
    expect(geo.rects).toHaveLength(0);
    expect(geo.points).toHaveLength(0);
  });

  it('空文字标签被丢弃', () => {
    expect(annotShapesToMaskGeometry([{ kind: 'text', x: 0, y: 0, text: '   ', color: C }]).labels).toHaveLength(0);
  });

  it('零面积矩形不进 mask（点一下没拖动）', () => {
    expect(annotShapesToMaskGeometry([{ kind: 'rect', x: 10, y: 10, w: 0, h: 0, color: C }]).rects).toHaveLength(0);
  });

  it('混合标注各归各位', () => {
    const geo = annotShapesToMaskGeometry([
      { kind: 'pen', points: [1, 2, 3, 4], color: C },
      { kind: 'rect', x: 0, y: 0, w: 10, h: 10, color: C },
      { kind: 'arrow', points: [0, 0, 9, 9], color: C },
      { kind: 'text', x: 0, y: 0, text: '换成花瓶', color: C },
    ]);
    expect(geo.polylines).toHaveLength(1);
    expect(geo.rects).toHaveLength(1);
    expect(geo.points).toHaveLength(1);
    expect(geo.labels).toEqual(['换成花瓶']);
  });
});

describe('hasMaskArea — 拦下「改了个寂寞」的付费空调用', () => {
  it('只有文字标签 → 没有可重绘面积', () => {
    const geo = annotShapesToMaskGeometry([{ kind: 'text', x: 0, y: 0, text: '改这个', color: C }]);
    expect(hasMaskArea(geo)).toBe(false);
  });

  it('完全没标注 → 没有可重绘面积', () => {
    expect(hasMaskArea(annotShapesToMaskGeometry([]))).toBe(false);
  });

  it('有笔画 / 有框 / 有箭头 任一 → 有面积', () => {
    for (const s of [
      { kind: 'pen', points: [1, 2, 3, 4], color: C },
      { kind: 'rect', x: 0, y: 0, w: 5, h: 5, color: C },
      { kind: 'arrow', points: [0, 0, 5, 5], color: C },
    ] as AnnotShape[]) {
      expect(hasMaskArea(annotShapesToMaskGeometry([s]))).toBe(true);
    }
  });
});

describe('annotBrushRadius — 细线要加粗成有面积的带子', () => {
  it('按图短边取，且有最小值兜底', () => {
    expect(annotBrushRadius(1000, 1000)).toBe(30);
    expect(annotBrushRadius(2000, 1000)).toBe(30); // 取短边
    expect(annotBrushRadius(100, 100)).toBe(12); // 小图走 12px 下限，不能细到模型无从下笔
  });
});
