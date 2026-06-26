import type {
  AgentPointerEvent,
  AgentPointerPhase,
  AgentPointerTone,
} from '@shared/contract';

interface AgentPointerFramePosition {
  x: number;
  y: number;
}

// ds-allow:start agent 指针可视化色板（canvas 字面色，按模式区分，非 UI token 场景）
const TONE_PALETTE: Record<AgentPointerTone, {
  spine: string;
  tip: string;
  glow: string;
  ring: string;
}> = {
  idle: {
    spine: '#14B8A6',
    tip: '#5EEAD4',
    glow: 'rgba(20,184,166,0.45)',
    ring: 'rgba(94,234,212,0.9)',
  },
  browser: {
    spine: '#38BDF8',
    tip: '#7DD3FC',
    glow: 'rgba(56,189,248,0.45)',
    ring: 'rgba(125,211,252,0.9)',
  },
  computer: {
    spine: '#34D399',
    tip: '#6EE7B7',
    glow: 'rgba(52,211,153,0.45)',
    ring: 'rgba(110,231,183,0.9)',
  },
  blocked: {
    spine: '#F87171',
    tip: '#FCA5A5',
    glow: 'rgba(248,113,113,0.45)',
    ring: 'rgba(252,165,165,0.9)',
  },
};
// ds-allow:end

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shouldDrawRing(phase: AgentPointerPhase): boolean {
  return phase === 'click' || phase === 'failed' || phase === 'blocked';
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

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load pointer frame image'));
    image.src = dataUrl;
  });
}

function drawNeoPointer(
  context: CanvasRenderingContext2D,
  position: AgentPointerFramePosition,
  tone: AgentPointerTone,
  phase: AgentPointerPhase,
  frameWidth: number,
  frameHeight: number,
): void {
  const palette = TONE_PALETTE[tone] || TONE_PALETTE.idle;
  const scale = clamp(Math.min(frameWidth, frameHeight) / 460, 0.8, 1.45);
  const x = position.x;
  const y = position.y;

  context.save();
  if (shouldDrawRing(phase)) {
    context.strokeStyle = palette.ring;
    context.lineWidth = 2.2 * scale;
    context.shadowColor = palette.glow;
    context.shadowBlur = 18 * scale;
    context.beginPath();
    context.arc(x, y, 18 * scale, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();

  context.save();
  context.translate(x - 7 * scale, y - 7 * scale);
  context.scale(scale, scale);
  context.shadowColor = palette.glow;
  context.shadowBlur = 16;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(37, 30);
  context.lineTo(21, 33);
  context.lineTo(30, 50);
  context.lineTo(22, 55);
  context.lineTo(13, 38);
  context.lineTo(3, 50);
  context.closePath();
  context.fillStyle = '#09100F'; // ds-allow:viz canvas 指针描边底色
  context.fill();
  context.strokeStyle = 'rgba(240,253,250,0.92)';
  context.lineWidth = 2.3;
  context.stroke();

  context.shadowBlur = 0;
  context.beginPath();
  context.moveTo(7, 8);
  context.lineTo(27, 27);
  context.lineTo(16, 29);
  context.strokeStyle = palette.spine;
  context.lineWidth = 2.6;
  context.stroke();

  context.beginPath();
  context.arc(1.5, 1.5, 3.2, 0, Math.PI * 2);
  context.fillStyle = palette.tip;
  context.fill();

  context.restore();
}

export async function composeAgentPointerFrame(
  dataUrl: string,
  event: AgentPointerEvent | null | undefined,
): Promise<string> {
  if (!event?.point || typeof document === 'undefined' || typeof Image === 'undefined') {
    return dataUrl;
  }
  try {
    const image = await loadDataUrlImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const position = resolveAgentPointerFramePosition(event, width, height);
    if (!position) {
      return dataUrl;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return dataUrl;
    }
    context.drawImage(image, 0, 0, width, height);
    drawNeoPointer(context, position, event.tone, event.phase, width, height);
    return canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}
