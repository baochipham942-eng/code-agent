import type { CanvasCamera } from './designCanvasTypes';

export const CANVAS_SCALE_MIN = 0.1;
export const CANVAS_SCALE_MAX = 5;
export const CANVAS_SCALE_STEP = 1.05;

export type WheelIntent = 'pan' | 'zoom';

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface PointerDragLike {
  button: number;
  spaceKey?: boolean;
  handTool?: boolean;
}

export function clamp(value: number, min = CANVAS_SCALE_MIN, max = CANVAS_SCALE_MAX): number {
  if (Number.isNaN(value)) return min;
  if (value === Infinity) return max;
  if (value === -Infinity) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeDelta(
  event: WheelLike,
  options: { linePx?: number; pagePx?: number } = {},
): { x: number; y: number } {
  const linePx = options.linePx ?? 16;
  const pagePx = options.pagePx ?? 800;
  const factor = event.deltaMode === 1 ? linePx : event.deltaMode === 2 ? pagePx : 1;
  const rawX = Number.isFinite(event.deltaX) ? event.deltaX : 0;
  const rawY = Number.isFinite(event.deltaY) ? event.deltaY : 0;
  return { x: rawX * factor, y: rawY * factor };
}

export function classifyWheelIntent(event: WheelLike): WheelIntent {
  return event.metaKey || event.ctrlKey || event.altKey ? 'zoom' : 'pan';
}

export function panBy(camera: CanvasCamera, delta: { x: number; y: number }): CanvasCamera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function panFromWheel(camera: CanvasCamera, event: WheelLike): CanvasCamera {
  const delta = normalizeDelta(event);
  const x = delta.x !== 0 ? delta.x : event.shiftKey ? delta.y : 0;
  const y = delta.x === 0 && event.shiftKey ? 0 : delta.y;
  return panBy(camera, { x: -x, y: -y });
}

export function zoomAt(
  camera: CanvasCamera,
  pointer: { x: number; y: number },
  deltaY: number,
  options: { min?: number; max?: number; step?: number; wheelUnit?: number } = {},
): CanvasCamera {
  const min = options.min ?? CANVAS_SCALE_MIN;
  const max = options.max ?? CANVAS_SCALE_MAX;
  const step = options.step ?? CANVAS_SCALE_STEP;
  const wheelUnit = options.wheelUnit ?? 100;
  const safeScale = clamp(camera.scale, min, max);
  const factor = Math.exp((-deltaY * Math.log(step)) / wheelUnit);
  const scale = clamp(safeScale * factor, min, max);
  const world = {
    x: (pointer.x - camera.x) / safeScale,
    y: (pointer.y - camera.y) / safeScale,
  };
  return {
    scale,
    x: pointer.x - world.x * scale,
    y: pointer.y - world.y * scale,
  };
}

export function zoomFromWheel(
  camera: CanvasCamera,
  pointer: { x: number; y: number },
  event: WheelLike,
): CanvasCamera {
  return zoomAt(camera, pointer, normalizeDelta(event).y);
}

export function classifyPointerDragIntent(event: PointerDragLike): 'pan' | 'none' {
  if (event.button === 1) return 'pan';
  if (event.handTool && event.button === 0) return 'pan';
  if (event.spaceKey && event.button === 0) return 'pan';
  return 'none';
}

export function dragEndCamera(camera: CanvasCamera, position: { x: number; y: number }): CanvasCamera {
  return { ...camera, x: position.x, y: position.y };
}
