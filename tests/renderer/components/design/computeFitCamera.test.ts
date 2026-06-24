// ---------------------------------------------------------------------------
// computeFitCamera —— #3 出图后画布 fit-to-view（真机 dogfood：图片太大看不全）：
//  给 bbox + 视口 → 算出居中且缩放到适配（留 padding）的相机。
//  屏幕变换约定：screen = world * scale + camera.{x,y}。
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { computeFitCamera } from '../../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasNode } from '../../../../src/renderer/components/design/designCanvasTypes';

function node(x: number, y: number, w: number, h: number): CanvasNode {
  return { id: `n-${x}-${y}`, src: 'a.png', role: 'output', x, y, width: w, height: h } as CanvasNode;
}

describe('computeFitCamera', () => {
  it('无节点 / 视口为 0 → 返回 null（不动相机）', () => {
    expect(computeFitCamera([], 800, 600)).toBeNull();
    expect(computeFitCamera([node(0, 0, 100, 100)], 0, 600)).toBeNull();
    expect(computeFitCamera([node(0, 0, 100, 100)], 800, 0)).toBeNull();
  });

  it('单个大图：缩放到适配视口（留 0.9 padding）并居中', () => {
    // bbox = 2000x1000，视口 800x600 → scale = min(800/2000, 600/1000)*0.9 = 0.4*0.9 = 0.36
    const cam = computeFitCamera([node(0, 0, 2000, 1000)], 800, 600);
    expect(cam).not.toBeNull();
    expect(cam!.scale).toBeCloseTo(0.36, 5);
    // bbox 中心 (1000,500) 应映射到视口中心 (400,300)。
    expect(1000 * cam!.scale + cam!.x).toBeCloseTo(400, 5);
    expect(500 * cam!.scale + cam!.y).toBeCloseTo(300, 5);
  });

  it('多节点：按整体 bounding box 适配 + 居中', () => {
    const cam = computeFitCamera([node(0, 0, 100, 100), node(200, 100, 100, 100)], 600, 600);
    // bbox = x[0..300] y[0..200] → 300x200，scale = min(600/300,600/200)*0.9 = 2*0.9 = 1.8
    expect(cam!.scale).toBeCloseTo(1.8, 5);
    const cx = 150;
    const cy = 100;
    expect(cx * cam!.scale + cam!.x).toBeCloseTo(300, 5);
    expect(cy * cam!.scale + cam!.y).toBeCloseTo(300, 5);
  });

  it('自定义 padding 生效', () => {
    const cam = computeFitCamera([node(0, 0, 1000, 1000)], 500, 500, 1);
    expect(cam!.scale).toBeCloseTo(0.5, 5);
  });
});
