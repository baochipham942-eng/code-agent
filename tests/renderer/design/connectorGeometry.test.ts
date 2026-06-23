import { describe, expect, it } from 'vitest';
import {
  connectorEndpoints,
  connectorMidpoint,
  type Box,
} from '../../../src/renderer/components/design/connectorGeometry';

const box = (over: Partial<Box> = {}): Box => ({ x: 0, y: 0, width: 100, height: 100, ...over });

describe('connectorEndpoints', () => {
  it('水平相邻：from 出右边，to 出左边', () => {
    const from = box({ x: 0, y: 0 }); // center (50,50)
    const to = box({ x: 300, y: 0 }); // center (350,50)
    const e = connectorEndpoints(from, to);
    expect(e.x1).toBe(100); // from 右边
    expect(e.y1).toBe(50);
    expect(e.x2).toBe(300); // to 左边
    expect(e.y2).toBe(50);
  });

  it('垂直相邻：from 出下边，to 出上边', () => {
    const from = box({ x: 0, y: 0 }); // center (50,50)
    const to = box({ x: 0, y: 300 }); // center (50,350)
    const e = connectorEndpoints(from, to);
    expect(e.x1).toBe(50);
    expect(e.y1).toBe(100); // from 下边
    expect(e.x2).toBe(50);
    expect(e.y2).toBe(300); // to 上边
  });

  it('对角：锚点落在边框上（不超出 box）', () => {
    const from = box({ x: 0, y: 0 });
    const to = box({ x: 300, y: 300 });
    const e = connectorEndpoints(from, to);
    // from 锚点须在 from 边框上（x=100 或 y=100）
    expect(e.x1 === 100 || e.y1 === 100).toBe(true);
    expect(e.x1).toBeGreaterThanOrEqual(0);
    expect(e.x1).toBeLessThanOrEqual(100);
  });

  it('节点重叠（中心重合）返回两中心（零长）', () => {
    const b = box({ x: 0, y: 0 });
    const e = connectorEndpoints(b, b);
    expect(e).toEqual({ x1: 50, y1: 50, x2: 50, y2: 50 });
  });

  it('零尺寸节点不抛、锚点取中心', () => {
    const from = box({ x: 0, y: 0, width: 0, height: 0 });
    const to = box({ x: 100, y: 0 });
    const e = connectorEndpoints(from, to);
    expect(Number.isFinite(e.x1)).toBe(true);
    expect(Number.isFinite(e.y1)).toBe(true);
  });
});

describe('connectorMidpoint', () => {
  it('取两端中点', () => {
    expect(connectorMidpoint({ x1: 0, y1: 0, x2: 100, y2: 40 })).toEqual({ x: 50, y: 20 });
  });
});
