import type {
  AgentPointerNativeCursorCapability,
  AgentPointerCoordSpace,
  AgentPointerEvent,
  AgentPointerPhase,
  AgentPointerPoint,
  AgentPointerPointFreshness,
  AgentPointerPointSource,
  AgentPointerSurface,
  AgentPointerTone,
} from '../contract/desktop';

export interface AgentPointerToolCallLike {
  id?: string | null;
  name: string;
  arguments?: Record<string, unknown>;
  result?: {
    success?: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  } | null;
}

const READ_ONLY_ACTIONS = new Set([
  'get_state',
  'observe',
  'get_ax_elements',
  'get_windows',
  'diagnose_app',
  'get_elements',
  'get_dom_snapshot',
  'get_a11y_snapshot',
  'get_workbench_state',
  'get_account_state',
  'get_content',
  'list_tabs',
  'get_logs',
  'screenshot',
]);

const CLICK_ACTIONS = new Set([
  'click',
  'click_text',
  'doubleClick',
  'rightClick',
  'smart_click',
  'wait_for_download',
]);

const TYPE_ACTIONS = new Set(['type', 'smart_type', 'fill_form', 'upload_file']);
const MOVE_ACTIONS = new Set(['move', 'smart_hover']);
const SCROLL_ACTIONS = new Set(['scroll']);
const DRAG_ACTIONS = new Set(['drag']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.min(92, Math.max(8, value));
}

function basename(value: string | null): string | null {
  if (!value) return null;
  return value.split('/').filter(Boolean).pop() || value;
}

function traceIdFromResult(result: AgentPointerToolCallLike['result']): string | null {
  const metadata = result?.metadata;
  const trace = asRecord(metadata?.workbenchTrace);
  return asString(metadata?.traceId) || asString(trace?.id);
}

function traceFromResult(result: AgentPointerToolCallLike['result']): Record<string, unknown> | null {
  return asRecord(result?.metadata?.workbenchTrace);
}

function ttlForPhase(phase: AgentPointerPhase): number {
  if (phase === 'failed' || phase === 'blocked') return 3600;
  if (phase === 'click' || phase === 'type' || phase === 'drag') return 2400;
  if (phase === 'scroll' || phase === 'move') return 1800;
  if (phase === 'read') return 1600;
  return 1400;
}

function labelFromTargetRef(targetRef: unknown): string | null {
  const ref = asRecord(targetRef);
  if (!ref) return null;
  return asString(ref.name)
    || asString(ref.textHint)
    || asString(ref.selector)
    || asString(ref.refId);
}

function pointFromBox(value: unknown): AgentPointerPoint | null {
  const box = asRecord(value);
  if (!box) return null;
  const x = asNumber(box.x) ?? asNumber(box.left);
  const y = asNumber(box.y) ?? asNumber(box.top);
  const width = asNumber(box.width);
  const height = asNumber(box.height);
  if (x !== null && y !== null && width !== null && height !== null) {
    return {
      x: x + width / 2,
      y: y + height / 2,
      unit: 'px',
    };
  }
  return null;
}

function pointFromTargetRef(targetRef: unknown): AgentPointerPoint | null {
  const ref = asRecord(targetRef);
  if (!ref) return null;
  return pointFromBox(ref.boundingBox)
    || pointFromBox(ref.bounds)
    || pointFromBox(ref.rect);
}

function isStaleTargetRef(targetRef: unknown, metadata: Record<string, unknown>): boolean {
  const ref = asRecord(targetRef);
  const freshness = asRecord(ref?.freshness);
  const state = asString(freshness?.state)
    || asString(ref?.freshness)
    || asString(ref?.status)
    || asString(metadata.targetRefStatus);
  const code = asString(metadata.code) || asString(metadata.errorCode);
  return ref?.stale === true
    || ref?.isStale === true
    || metadata.targetRefStale === true
    || state === 'stale'
    || state === 'expired'
    || state === 'needs_re_read'
    || code === 'STALE_TARGET_REF'
    || code === 'TARGET_REF_STALE';
}

function pointFromWindowLocal(value: unknown): AgentPointerPoint | null {
  const point = asRecord(value);
  if (!point) return null;
  const x = asNumber(point.x);
  const y = asNumber(point.y);
  return x !== null && y !== null ? { x, y, unit: 'px' } : null;
}

function coordSpaceFromValue(value: unknown, fallback: AgentPointerCoordSpace): AgentPointerCoordSpace {
  const record = asRecord(value);
  const coordSpace = asString(record?.coordSpace) || asString(record?.coordinateSpace);
  if (
    coordSpace === 'browserViewport'
    || coordSpace === 'screen'
    || coordSpace === 'windowLocal'
    || coordSpace === 'surfacePreview'
  ) {
    return coordSpace;
  }
  return fallback;
}

function nativeCursorCapabilityFromMetadata(metadata: Record<string, unknown>): AgentPointerNativeCursorCapability | null {
  const raw = asRecord(metadata.agentPointerNativeCursor) || asRecord(metadata.nativeCursor);
  if (!raw) return null;
  const status = asString(raw.status);
  const provider = asString(raw.provider);
  if (
    (status !== 'native' && status !== 'fallback' && status !== 'unavailable')
    || (provider !== 'cua-driver' && provider !== 'renderer' && provider !== 'pip' && provider !== 'none')
  ) {
    return null;
  }
  const fallbackSurface = asString(raw.fallbackSurface);
  return {
    enabled: raw.enabled === true,
    status,
    provider,
    supportsSystemOverlay: raw.supportsSystemOverlay === true,
    reason: asString(raw.reason),
    fallbackSurface: fallbackSurface === 'renderer' || fallbackSurface === 'pip' ? fallbackSurface : null,
    checkedAtMs: asNumber(raw.checkedAtMs),
  };
}

function fallbackPreviewPoint(surface: AgentPointerSurface, phase: AgentPointerPhase): AgentPointerPoint {
  if (phase === 'read') {
    return { x: 24, y: 28, unit: 'percent' };
  }
  return surface === 'browser'
    ? { x: 40, y: 42, unit: 'percent' }
    : { x: 46, y: 44, unit: 'percent' };
}

function resolvePointerPhase(action: string, toolName: string, success?: boolean | null): AgentPointerPhase {
  if (success === false) return 'failed';
  if (READ_ONLY_ACTIONS.has(action)) return 'read';
  if (DRAG_ACTIONS.has(action)) return 'drag';
  if (TYPE_ACTIONS.has(action)) return 'type';
  if (SCROLL_ACTIONS.has(action)) return 'scroll';
  if (MOVE_ACTIONS.has(action)) return 'move';
  if (CLICK_ACTIONS.has(action)) return 'click';
  return toolName === 'browser_action' || toolName === 'computer_use' ? 'preview' : 'read';
}

function surfaceForToolName(toolName: string): AgentPointerSurface | null {
  if (toolName === 'browser_action') return 'browser';
  if (toolName === 'computer_use') return 'computer';
  return null;
}

function toneFor(surface: AgentPointerSurface, success?: boolean | null): AgentPointerTone {
  if (success === false) return 'blocked';
  return surface === 'browser' ? 'browser' : 'computer';
}

function targetSourceForArgs(args: Record<string, unknown>, metadata: Record<string, unknown>): AgentPointerEvent['targetSource'] {
  if (args.targetRef || metadata.targetRef) return 'targetRef';
  if (asString(args.axPath) || asString(metadata.targetAxPath)) return 'axPath';
  if (asString(args.windowRef) || asString(metadata.targetWindowRef) || asRecord(args.windowLocalPoint) || asRecord(metadata.windowLocalPoint)) return 'windowRef';
  if (asString(args.selector) || asString(args.role) || asString(args.name) || metadata.pointerTarget) return 'selector';
  if (asNumber(args.x) !== null && asNumber(args.y) !== null) return 'coordinate';
  return 'fallback';
}

function buildPoint(args: Record<string, unknown>, metadata: Record<string, unknown>, surface: AgentPointerSurface, phase: AgentPointerPhase): {
  point: AgentPointerPoint;
  coordSpace: AgentPointerCoordSpace;
  source: AgentPointerPointSource;
  freshness: AgentPointerPointFreshness;
} {
  const targetRef = metadata.targetRef || args.targetRef;
  const targetRefIsStale = isStaleTargetRef(targetRef, metadata);
  const fromTargetRef = targetRefIsStale ? null : pointFromTargetRef(targetRef);
  if (fromTargetRef) {
    return {
      point: fromTargetRef,
      coordSpace: 'browserViewport',
      source: 'targetRefBBox',
      freshness: 'fresh',
    };
  }

  const pointerTarget = asRecord(metadata.pointerTarget);
  const fromPointerTarget = pointFromBox(pointerTarget?.boundingBox)
    || pointFromBox(pointerTarget?.bounds)
    || pointFromBox(pointerTarget?.rect);
  if (fromPointerTarget) {
    return {
      point: fromPointerTarget,
      coordSpace: coordSpaceFromValue(pointerTarget, surface === 'browser' ? 'browserViewport' : 'windowLocal'),
      source: 'pointerTargetBBox',
      freshness: 'fresh',
    };
  }

  const axFrame = metadata.targetAxFrame
    || metadata.axFrame
    || metadata.targetFrame
    || args.targetAxFrame
    || args.axFrame;
  const fromAxFrame = pointFromBox(axFrame);
  if (fromAxFrame) {
    return {
      point: fromAxFrame,
      coordSpace: coordSpaceFromValue(axFrame, 'screen'),
      source: 'axFrame',
      freshness: 'fresh',
    };
  }

  const windowLocal = pointFromWindowLocal(args.windowLocalPoint)
    || pointFromWindowLocal(metadata.windowLocalPoint);
  if (windowLocal) {
    return {
      point: windowLocal,
      coordSpace: 'windowLocal',
      source: 'windowLocalPoint',
      freshness: 'fresh',
    };
  }

  const windowX = asNumber(args.windowX);
  const windowY = asNumber(args.windowY);
  if (windowX !== null && windowY !== null) {
    return {
      point: { x: windowX, y: windowY, unit: 'px' },
      coordSpace: 'windowLocal',
      source: 'windowLocalCoordinate',
      freshness: 'fresh',
    };
  }

  const x = asNumber(args.x);
  const y = asNumber(args.y);
  if (x !== null && y !== null) {
    return {
      point: { x, y, unit: 'px' },
      coordSpace: 'screen',
      source: 'screenCoordinate',
      freshness: 'fresh',
    };
  }

  return {
    point: fallbackPreviewPoint(surface, phase),
    coordSpace: 'surfacePreview',
    source: 'fallback',
    freshness: targetRefIsStale ? 'stale' : 'fallback',
  };
}

function targetLabelFor(args: Record<string, unknown>, metadata: Record<string, unknown>): string | null {
  const targetRef = metadata.targetRef || args.targetRef;
  const pointerTarget = asRecord(metadata.pointerTarget);
  const x = asNumber(args.x);
  const y = asNumber(args.y);
  return asString(pointerTarget?.label)
    || labelFromTargetRef(targetRef)
    || asString(args.selector)
    || asString(args.role)
    || asString(args.name)
    || asString(metadata.targetName)
    || asString(args.targetApp)
    || asString(metadata.targetApp)
    || basename(asString(metadata.path))
    || (x !== null && y !== null ? `${x},${y}` : null);
}

export function buildAgentPointerEventFromToolCall(
  toolCall: AgentPointerToolCallLike,
): AgentPointerEvent | null {
  const surface = surfaceForToolName(toolCall.name);
  if (!surface) return null;

  const args = toolCall.arguments || {};
  const metadata = toolCall.result?.metadata || {};
  const action = asString(args.action) || 'unknown';
  const success = toolCall.result?.success ?? null;
  const phase = resolvePointerPhase(action, toolCall.name, success);
  if (phase === 'read' && action !== 'observe' && action !== 'screenshot') {
    return null;
  }

  const { point, coordSpace, source, freshness } = buildPoint(args, metadata, surface, phase);
  const trace = traceFromResult(toolCall.result);
  const startedAtMs = asNumber(metadata.startedAtMs) ?? asNumber(trace?.startedAtMs);
  const completedAtMs = asNumber(metadata.completedAtMs) ?? asNumber(trace?.completedAtMs);
  const occurredAtMs = asNumber(metadata.occurredAtMs) ?? completedAtMs ?? startedAtMs ?? Date.now();
  const expiresAtMs = asNumber(metadata.expiresAtMs) ?? occurredAtMs + ttlForPhase(phase);
  return {
    id: `agent-pointer-${toolCall.id || traceIdFromResult(toolCall.result) || action}`,
    surface,
    tone: toneFor(surface, success),
    phase,
    coordSpace,
    point: point.unit === 'percent'
      ? { ...point, x: clampPercent(point.x), y: clampPercent(point.y) }
      : point,
    pointSource: source,
    pointFreshness: freshness,
    targetLabel: targetLabelFor(args, metadata),
    targetSource: targetSourceForArgs(args, metadata),
    traceId: traceIdFromResult(toolCall.result),
    nativeCursor: nativeCursorCapabilityFromMetadata(metadata),
    success,
    occurredAtMs,
    startedAtMs: startedAtMs ?? null,
    completedAtMs: completedAtMs ?? null,
    expiresAtMs,
  };
}

export function getAgentPointerLabel(event: AgentPointerEvent): string {
  const surface = event.surface === 'browser' ? 'Browser' : 'Computer';
  const target = event.targetLabel ? ` · ${event.targetLabel}` : '';
  if (event.phase === 'failed' || event.phase === 'blocked') return `${surface} blocked${target}`;
  if (event.phase === 'click') return `${surface} click${target}`;
  if (event.phase === 'type') return `${surface} input${target}`;
  if (event.phase === 'drag') return `${surface} drag${target}`;
  if (event.phase === 'scroll') return `${surface} scroll${target}`;
  if (event.phase === 'move') return `${surface} move${target}`;
  return `${surface} pointer${target}`;
}
