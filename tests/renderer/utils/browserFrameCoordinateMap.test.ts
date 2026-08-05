import { describe, expect, it } from 'vitest';
import {
  mapDisplayPointToViewport,
  resolveObjectContainLayout,
} from '../../../src/shared/utils/browserFrameCoordinateMap';

describe('browserFrameCoordinateMap（object-contain letterbox）', () => {
  it('宽内容 letterbox：上下黑边偏移计入映射', () => {
    // 容器 400×300，内容 400×200 → 显示 400×200，上下各 50 黑边
    const display = { width: 400, height: 300 };
    const content = { width: 400, height: 200 };
    const layout = resolveObjectContainLayout(display, content);
    expect(layout).toMatchObject({
      offsetX: 0,
      offsetY: 50,
      displayedWidth: 400,
      displayedHeight: 200,
    });

    // 点在内容中心 (200, 150) → 视口 (200, 100)
    expect(mapDisplayPointToViewport({ x: 200, y: 150 }, display, content)).toEqual({
      x: 200,
      y: 100,
    });
    // 点在上黑边 → null
    expect(mapDisplayPointToViewport({ x: 200, y: 10 }, display, content)).toBeNull();
  });

  it('高内容 pillarbox：左右黑边偏移 + 缩放两档', () => {
    // 容器 400×400，内容 200×400 → 显示 200×400，左右各 100
    const display = { width: 400, height: 400 };
    const content = { width: 200, height: 400 };
    const layout = resolveObjectContainLayout(display, content);
    expect(layout).toMatchObject({
      offsetX: 100,
      offsetY: 0,
      displayedWidth: 200,
      displayedHeight: 400,
      scaleX: 1,
      scaleY: 1,
    });
    expect(mapDisplayPointToViewport({ x: 200, y: 200 }, display, content)).toEqual({
      x: 100,
      y: 200,
    });
    // 左黑边
    expect(mapDisplayPointToViewport({ x: 20, y: 200 }, display, content)).toBeNull();

    // 缩放档：容器 200×200，内容 800×400 → 显示 200×100，上下 letterbox 50，scale 4
    const scaledDisplay = { width: 200, height: 200 };
    const scaledContent = { width: 800, height: 400 };
    const scaledLayout = resolveObjectContainLayout(scaledDisplay, scaledContent);
    expect(scaledLayout?.scaleX).toBeCloseTo(4);
    expect(scaledLayout?.scaleY).toBeCloseTo(4);
    expect(scaledLayout?.offsetY).toBeCloseTo(50);
    // 显示点 (100, 100) → 内容区相对 (100, 50) → 视口 (400, 200)
    const mapped = mapDisplayPointToViewport({ x: 100, y: 100 }, scaledDisplay, scaledContent);
    expect(mapped?.x).toBeCloseTo(400);
    expect(mapped?.y).toBeCloseTo(200);
  });

  // 变异：若漏掉 letterbox offset，靠近内容上沿的点会映射错
  it('变异防护：忽略 offsetY 时 letterbox 映射会偏离真实视口', () => {
    const display = { width: 400, height: 300 };
    const content = { width: 400, height: 200 };
    // 显示点 y=100 落在内容区上沿附近（offsetY=50）
    const correct = mapDisplayPointToViewport({ x: 200, y: 100 }, display, content);
    // 错误实现：直接用 display 坐标按比例缩，不减 offset
    const buggy = {
      x: (200 / display.width) * content.width,
      y: (100 / display.height) * content.height,
    };
    expect(correct).toEqual({ x: 200, y: 50 });
    expect(buggy.y).not.toBeCloseTo(correct!.y);
  });

  // 变异：scale 用反（显示/内容）会把坐标压到错误量级
  it('变异防护：反转 scale 会把视口坐标缩到显示尺度', () => {
    const display = { width: 200, height: 200 };
    const content = { width: 800, height: 400 };
    const correct = mapDisplayPointToViewport({ x: 100, y: 100 }, display, content);
    const layout = resolveObjectContainLayout(display, content)!;
    const inverted = {
      x: (100 - layout.offsetX) / layout.scaleX,
      y: (100 - layout.offsetY) / layout.scaleY,
    };
    expect(correct!.x).toBeCloseTo(400);
    expect(inverted.x).toBeCloseTo(25);
    expect(inverted.x).not.toBeCloseTo(correct!.x);
  });
});
