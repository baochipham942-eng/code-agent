import { describe, expect, it } from 'vitest';
import {
  CANVAS_SCALE_MAX,
  CANVAS_SCALE_MIN,
  classifyPointerDragIntent,
  classifyWheelIntent,
  clamp,
  panFromWheel,
  zoomAt,
  zoomFromWheel,
} from '../../../src/renderer/components/design/canvasCameraInput';
import type { CanvasCamera } from '../../../src/renderer/components/design/designCanvasTypes';

describe('canvasCameraInput wheel classification', () => {
  it('plain wheel pans; ctrl/meta/alt wheel zooms', () => {
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 10 })).toBe('pan');
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 10, ctrlKey: true })).toBe('zoom');
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 10, metaKey: true })).toBe('zoom');
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 10, altKey: true })).toBe('zoom');
  });

  it('plain wheel moves camera, shift vertical wheel becomes horizontal pan', () => {
    const camera: CanvasCamera = { x: 10, y: 20, scale: 1 };
    expect(panFromWheel(camera, { deltaX: 5, deltaY: -10 })).toEqual({ x: 5, y: 30, scale: 1 });
    expect(panFromWheel(camera, { deltaX: 0, deltaY: 12, shiftKey: true })).toEqual({ x: -2, y: 20, scale: 1 });
  });
});

describe('canvasCameraInput zoom stability', () => {
  it('zooms around pointer without drifting the pointed world coordinate', () => {
    const camera: CanvasCamera = { x: 0, y: 0, scale: 1 };
    const pointer = { x: 100, y: 50 };
    const next = zoomAt(camera, pointer, -100);
    expect(next.scale).toBeGreaterThan(1);
    expect((pointer.x - next.x) / next.scale).toBeCloseTo(100, 6);
    expect((pointer.y - next.y) / next.scale).toBeCloseTo(50, 6);
  });

  it('continuous zoom-out is monotonic and never reverses into zoom-in', () => {
    let camera: CanvasCamera = { x: 0, y: 0, scale: 1 };
    for (let i = 0; i < 40; i++) {
      const next = zoomFromWheel(camera, { x: 120, y: 80 }, { deltaX: 0, deltaY: 120, ctrlKey: true });
      expect(next.scale).toBeLessThanOrEqual(camera.scale);
      expect(next.scale).toBeGreaterThanOrEqual(CANVAS_SCALE_MIN);
      camera = next;
    }
  });

  it('clamps invalid or out-of-range scale values', () => {
    expect(clamp(Number.NaN)).toBe(CANVAS_SCALE_MIN);
    expect(clamp(Infinity)).toBe(CANVAS_SCALE_MAX);
    expect(clamp(-Infinity)).toBe(CANVAS_SCALE_MIN);
    expect(clamp(100)).toBe(CANVAS_SCALE_MAX);
  });
});

describe('canvasCameraInput pointer drag classification', () => {
  it('uses middle drag or space+left drag for pan', () => {
    expect(classifyPointerDragIntent({ button: 1 })).toBe('pan');
    expect(classifyPointerDragIntent({ button: 0, spaceKey: true })).toBe('pan');
    expect(classifyPointerDragIntent({ button: 0 })).toBe('none');
  });
});
