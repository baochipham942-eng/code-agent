import type { AgentPointerEvent } from '@shared/contract';

interface AgentPointerFramePosition {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveAgentPointerFramePosition(
  event: AgentPointerEvent | null | undefined,
  width: number,
  height: number,
): AgentPointerFramePosition | null {
  if (!event?.point || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const rawX = event.point.unit === 'percent'
    ? (event.point.x / 100) * width
    : event.point.x;
  const rawY = event.point.unit === 'percent'
    ? (event.point.y / 100) * height
    : event.point.y;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
    return null;
  }
  const margin = Math.max(12, Math.min(width, height) * 0.018);
  return {
    x: clamp(rawX, margin, width - margin),
    y: clamp(rawY, margin, height - margin),
  };
}
