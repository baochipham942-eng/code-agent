import { describe, expect, it } from 'vitest';
import { imageCoordsToScreenPoints } from '../../../../src/host/tools/vision/coordinateTransform';

describe('imageCoordsToScreenPoints', () => {
  it('按 displayPointWidth / analyzedWidth 等比换算（残差比例情形）', () => {
    // 分析图 1568 宽，屏幕逻辑 1440 点宽 → scaleX = 1440/1568
    const result = imageCoordsToScreenPoints(
      { x: 784, y: 600 },
      { analyzedWidth: 1568, analyzedHeight: 1176, displayPointWidth: 1440, displayPointHeight: 1080 },
    );
    expect(result.x).toBeCloseTo(720, 1);
    expect(result.y).toBeCloseTo(551.02, 1);
  });

  it('分析图已是点空间 → 变换近似 identity', () => {
    const result = imageCoordsToScreenPoints(
      { x: 200, y: 150 },
      { analyzedWidth: 1440, analyzedHeight: 900, displayPointWidth: 1440, displayPointHeight: 900 },
    );
    expect(result.x).toBe(200);
    expect(result.y).toBe(150);
  });

  it('analyzedWidth 为 null → 原样返回（无尺寸记账，保留现有行为）', () => {
    const coord = { x: 123, y: 456 };
    expect(
      imageCoordsToScreenPoints(coord, {
        analyzedWidth: null,
        analyzedHeight: null,
        displayPointWidth: 1440,
        displayPointHeight: 900,
      }),
    ).toEqual(coord);
  });

  it('displayPointWidth 为 null → 原样返回（getDisplayInfo 失败降级）', () => {
    const coord = { x: 50, y: 80 };
    expect(
      imageCoordsToScreenPoints(coord, {
        analyzedWidth: 1568,
        analyzedHeight: 1176,
        displayPointWidth: null,
        displayPointHeight: null,
      }),
    ).toEqual(coord);
  });

  it('analyzedWidth <= 0 → 原样返回（防御非法尺寸）', () => {
    const coord = { x: 10, y: 20 };
    expect(
      imageCoordsToScreenPoints(coord, {
        analyzedWidth: 0,
        analyzedHeight: 1176,
        displayPointWidth: 1440,
        displayPointHeight: 900,
      }),
    ).toEqual(coord);
  });
});
