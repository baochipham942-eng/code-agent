import { describe, expect, it } from 'vitest';
import {
  worldRectToImageRegion,
  normalizeDragRect,
} from '../../../src/renderer/components/design/designCanvasMask';

const node = { x: 100, y: 100, width: 200, height: 200 };

describe('worldRectToImageRegion', () => {
  it('完全在图内：平移到图局部坐标', () => {
    expect(worldRectToImageRegion({ x: 120, y: 130, width: 40, height: 50 }, node)).toEqual({
      x: 20,
      y: 30,
      width: 40,
      height: 50,
    });
  });

  it('部分越界：与图求交后裁剪', () => {
    // 红框右下超出图边界
    expect(worldRectToImageRegion({ x: 250, y: 250, width: 100, height: 100 }, node)).toEqual({
      x: 150,
      y: 150,
      width: 50,
      height: 50,
    });
  });

  it('完全不重叠返回 null', () => {
    expect(worldRectToImageRegion({ x: 0, y: 0, width: 50, height: 50 }, node)).toBeNull();
  });
});

describe('normalizeDragRect', () => {
  it('正向拖拽', () => {
    expect(normalizeDragRect(10, 20, 40, 60)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
  it('反向拖拽（终点在起点左上）', () => {
    expect(normalizeDragRect(40, 60, 10, 20)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});
