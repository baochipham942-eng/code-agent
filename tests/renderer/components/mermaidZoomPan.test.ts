// Mermaid 缩放/平移状态逻辑纯函数单测（组件交互的数学核心，抽出来独立验）
import { describe, it, expect } from 'vitest';
import {
  clampMermaidScale,
  zoomMermaidViewAt,
  mermaidWheelZoomFactor,
  type MermaidView,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

describe('clampMermaidScale', () => {
  it('低于下限收到 0.1，高于上限收到 4', () => {
    expect(clampMermaidScale(0.01)).toBe(0.1);
    expect(clampMermaidScale(100)).toBe(4);
  });

  it('区间内的值原样通过', () => {
    expect(clampMermaidScale(1)).toBe(1);
    expect(clampMermaidScale(2.5)).toBe(2.5);
  });
});

describe('zoomMermaidViewAt', () => {
  const view: MermaidView = { scale: 1, x: 16, y: 16 };

  it('锚点处的图内容在缩放前后保持不动', () => {
    const px = 200;
    const py = 120;
    const next = zoomMermaidViewAt(view, px, py, 2);
    expect(next.scale).toBe(2);
    // 锚点不变式：缩放前 (px - x) / scale == 缩放后 (px - x') / scale'
    expect((px - next.x) / next.scale).toBeCloseTo((px - view.x) / view.scale);
    expect((py - next.y) / next.scale).toBeCloseTo((py - view.y) / view.scale);
  });

  it('目标 scale 越界时先 clamp 再换算（锚定基于实际生效的 scale）', () => {
    const next = zoomMermaidViewAt(view, 200, 120, 1000);
    expect(next.scale).toBe(4);
    expect((200 - next.x) / next.scale).toBeCloseTo((200 - view.x) / view.scale);
  });

  it('scale 不变时视图原样返回（无漂移）', () => {
    const next = zoomMermaidViewAt(view, 200, 120, 1);
    expect(next).toEqual(view);
  });
});

describe('mermaidWheelZoomFactor', () => {
  it('向上滚（负 deltaY）放大、向下滚缩小', () => {
    expect(mermaidWheelZoomFactor(-120)).toBeGreaterThan(1);
    expect(mermaidWheelZoomFactor(120)).toBeLessThan(1);
  });

  it('超大 deltaY 被 clamp，单格不会飞出数量级', () => {
    expect(mermaidWheelZoomFactor(-100000)).toBeCloseTo(mermaidWheelZoomFactor(-100));
    expect(mermaidWheelZoomFactor(100000)).toBeCloseTo(mermaidWheelZoomFactor(100));
  });

  it('deltaY 为 0 时因子为 1', () => {
    expect(mermaidWheelZoomFactor(0)).toBe(1);
  });
});
