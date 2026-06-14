import type { Message } from '@shared/contract/message';
import type { ModelFallbackStrategy, ModelFallbackToolPolicy, ModelFallbackTraceStep, ModelProviderIdentity } from '@shared/contract/modelDecision';
import { generateMessageId } from '@shared/utils/id';

export interface ModelFallbackNoticePayload {
  reason: string;
  from: string;
  to: string;
  category?: string;
  strategy?: ModelFallbackStrategy;
  tried?: ModelFallbackTraceStep[];
  skipped?: ModelFallbackTraceStep[];
  toolPolicy?: ModelFallbackToolPolicy;
  fromIdentity?: ModelProviderIdentity;
  toIdentity?: ModelProviderIdentity;
}

interface ModelFallbackNoticeEnvelope {
  __modelFallbackNotice: ModelFallbackNoticePayload;
}

export function encodeModelFallbackNotice(payload: ModelFallbackNoticePayload): string {
  return JSON.stringify({ __modelFallbackNotice: payload } satisfies ModelFallbackNoticeEnvelope);
}

export function isModelFallbackNoticeContent(content: string): boolean {
  return typeof content === 'string' && content.includes('"__modelFallbackNotice"');
}

const FALLBACK_TRACE_STATUSES = new Set<ModelFallbackTraceStep['status']>(['tried', 'skipped', 'selected', 'exhausted']);
const FALLBACK_STRATEGIES = new Set<ModelFallbackStrategy>([
  'adaptive-provider-fallback',
  'adaptive-capability-fallback',
  'adaptive-main-task-recovery',
]);

function normalizeFallbackTraceSteps(value: unknown): ModelFallbackTraceStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value
    .map((item): ModelFallbackTraceStep | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (typeof record.provider !== 'string' || !record.provider) return null;
      if (typeof record.status !== 'string' || !FALLBACK_TRACE_STATUSES.has(record.status as ModelFallbackTraceStep['status'])) {
        return null;
      }
      if (typeof record.reason !== 'string' || !record.reason) return null;
      const providerIdentity = normalizeProviderIdentity(record.providerIdentity);
      return {
        provider: record.provider,
        ...(typeof record.model === 'string' && record.model ? { model: record.model } : {}),
        ...(providerIdentity ? { providerIdentity } : {}),
        status: record.status as ModelFallbackTraceStep['status'],
        reason: record.reason,
        ...(typeof record.category === 'string' && record.category ? { category: record.category } : {}),
        ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail } : {}),
      };
    })
    .filter((step): step is ModelFallbackTraceStep => step !== null);
  return steps.length > 0 ? steps : undefined;
}

function normalizeFallbackToolPolicy(value: unknown): ModelFallbackToolPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== 'disabled') return undefined;
  if (record.reason !== 'fallback_model_without_tool_support') return undefined;
  if (typeof record.originalToolCount !== 'number' || typeof record.effectiveToolCount !== 'number') return undefined;
  const disabledToolNames = Array.isArray(record.disabledToolNames)
    ? record.disabledToolNames.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
  return {
    status: 'disabled',
    reason: 'fallback_model_without_tool_support',
    originalToolCount: record.originalToolCount,
    effectiveToolCount: record.effectiveToolCount,
    ...(disabledToolNames && disabledToolNames.length > 0 ? { disabledToolNames } : {}),
    ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail } : {}),
  };
}

function normalizeProviderIdentity(value: unknown): ModelProviderIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== 'string' || !record.provider) return undefined;
  const protocol = record.protocol === 'openai' || record.protocol === 'claude' ? record.protocol : undefined;
  return {
    provider: record.provider,
    ...(typeof record.displayName === 'string' && record.displayName ? { displayName: record.displayName } : {}),
    ...(typeof record.sourceLabel === 'string' && record.sourceLabel ? { sourceLabel: record.sourceLabel } : {}),
    ...(protocol ? { protocol } : {}),
    ...(typeof record.transportLabel === 'string' && record.transportLabel ? { transportLabel: record.transportLabel } : {}),
    ...(typeof record.endpoint === 'string' && record.endpoint ? { endpoint: record.endpoint } : {}),
  };
}

export function parseModelFallbackNotice(content: string): ModelFallbackNoticePayload | null {
  try {
    const parsed = JSON.parse(content) as Partial<ModelFallbackNoticeEnvelope>;
    const notice = parsed?.__modelFallbackNotice;
    if (
      notice
      && typeof notice.reason === 'string'
      && typeof notice.from === 'string'
      && typeof notice.to === 'string'
    ) {
      const tried = normalizeFallbackTraceSteps(notice.tried);
      const skipped = normalizeFallbackTraceSteps(notice.skipped);
      const toolPolicy = normalizeFallbackToolPolicy(notice.toolPolicy);
      const fromIdentity = normalizeProviderIdentity(notice.fromIdentity);
      const toIdentity = normalizeProviderIdentity(notice.toIdentity);
      return {
        reason: notice.reason,
        from: notice.from,
        to: notice.to,
        ...(typeof notice.category === 'string' && notice.category ? { category: notice.category } : {}),
        ...(typeof notice.strategy === 'string' && FALLBACK_STRATEGIES.has(notice.strategy as ModelFallbackStrategy)
          ? { strategy: notice.strategy as ModelFallbackStrategy }
          : {}),
        ...(tried ? { tried } : {}),
        ...(skipped ? { skipped } : {}),
        ...(toolPolicy ? { toolPolicy } : {}),
        ...(fromIdentity ? { fromIdentity } : {}),
        ...(toIdentity ? { toIdentity } : {}),
      };
    }
  } catch {
    /* 非 JSON / 格式不符 */
  }
  return null;
}

export function buildModelFallbackNoticeMessage(payload: ModelFallbackNoticePayload): Message {
  return {
    id: generateMessageId(),
    role: 'system',
    source: 'model',
    content: encodeModelFallbackNotice(payload),
    timestamp: Date.now(),
  };
}
