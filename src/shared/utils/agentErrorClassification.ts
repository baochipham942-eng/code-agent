// ============================================================================
// AgentErrorClassification — agent error 事件 → 结构化失败元数据的纯分类
//
// 从 renderer/hooks/agent/effects/useSessionLifecycleEffects 原地迁来（2026-09-26，
// N-CHAT-EMPTY-FINAL-NO-EXIT）：失败终态要落库（会话重开后仍显示失败卡 + 重试入口），
// host 侧（/api/run 收尾）与 renderer 侧必须用同一份分类，否则两边 category 漂移，
// 同一次失败在刷新前后显示不同的出路。迁移时在原 renderer 逻辑之上新增了
// structuredFailureCode 分支（识别 runFinalizer 的 MODEL_AUTH/MODEL_QUOTA/
// MODEL_UNAVAILABLE 结构化标记）——不是逐字搬运，与迁移前 renderer 行为的差异
// 仅此一处（有测试钉住），做迁移比对时别按逐字对。
// ============================================================================

import type { AgentErrorMetadata } from '../contract';
import { hasInsufficientBalanceSignal } from './providerError';

type AgentErrorPayload = Record<string, unknown>;

function isRecord(value: unknown): value is AgentErrorPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentErrorPayload(data: unknown): AgentErrorPayload {
  if (!isRecord(data)) return {};
  const nested = isRecord(data.data) ? data.data : {};
  return { ...data, ...nested };
}

function getNumberPayloadField(data: unknown, field: string): number | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'number' ? value : undefined;
}

export function getAgentErrorMessage(data: unknown): string | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = typeof payload.message === 'string'
    ? payload.message.trim()
    : typeof payload.error === 'string'
      ? payload.error.trim()
      : '';
  return message || null;
}

export function isTerminalAgentError(data: unknown): boolean {
  const payload = normalizeAgentErrorPayload(data);
  return payload.terminal !== false
    && payload.level !== 'warning'
    && payload.severity !== 'warning';
}

function isGenericRunFailure(payload: AgentErrorPayload): boolean {
  return payload.code === 'RUN_FAILED' || typeof payload.code !== 'string';
}

function getStringPayloadField(data: unknown, field: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 把 agent error 事件分类成结构化错误（写进 message.metadata.agentError，由
 * AgentErrorCard 渲染）。title/suggestion 文案不在这里生成——文案随 i18n 走，
 * 分类只产出 category + 排障字段，卡片渲染时按 category 查表。
 */
export function classifyAgentError(
  data: unknown,
  context?: { modelId?: string },
): AgentErrorMetadata | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = getAgentErrorMessage(payload);
  if (!message) return null;

  const base = {
    code: typeof payload.code === 'string' ? payload.code : undefined,
    traceId: getStringPayloadField(payload, 'traceId') ?? getStringPayloadField(payload, 'requestId'),
    rawMessage: message,
    // host 在失败事件里带的是这一轮真跑的模型，优先用它；context 是前端当前选中的
    // 模型，刚切过模型时会指认一个根本没跑过的模型，只能当兜底。
    modelId: getStringPayloadField(payload.details, 'model') ?? context?.modelId,
    provider: getStringPayloadField(payload.details, 'provider'),
    goalAbort: payload.goalAbort === true,
    timestamp: Date.now(),
  };

  const explicitStatus = getNumberPayloadField(payload, 'httpStatus')
    ?? getNumberPayloadField(payload, 'statusCode')
    ?? getNumberPayloadField(payload, 'status')
    ?? getNumberPayloadField(payload.details, 'httpStatus');

  if (payload.code === 'CONTEXT_LENGTH_EXCEEDED') {
    const details = payload.details;
    return {
      ...base,
      category: 'context_length',
      httpStatus: explicitStatus,
      requestedTokens: getNumberPayloadField(details, 'requested'),
      maxTokens: getNumberPayloadField(details, 'max'),
    };
  }

  if (payload.code === 'IMAGE_PAYLOAD_EXCEEDED') {
    return {
      ...base,
      category: 'image_payload',
      httpStatus: explicitStatus,
    };
  }

  if (isGenericRunFailure(payload)) {
    const normalized = message.trim().toLowerCase();
    const hasStatus = (status: number) => new RegExp(`\\b${status}\\b`).test(message);
    const hasAuthSignal = normalized.includes('invalid api key')
      || normalized.includes('incorrect api key')
      || normalized.includes('unauthorized');
    const hasBalanceSignal = hasInsufficientBalanceSignal({ ...payload, message });

    // runFinalizer 的结构化 failure 标记（getModelAuthFailureMarker 等）优先于文本猜测：
    // 国内 provider 的 401 文案是中文（「API Key 无效、已过期」），英文关键词认不出，
    // 不看标记就会漏成 generic，用户拿不到「去设置修 Key」的出路。
    const structuredFailureCode = isRecord(payload.failure)
      ? getStringPayloadField(payload.failure, 'code')
      : undefined;
    if (structuredFailureCode === 'MODEL_AUTH') {
      return { ...base, category: 'auth', httpStatus: explicitStatus ?? 401 };
    }
    if (structuredFailureCode === 'MODEL_QUOTA') {
      return { ...base, category: 'insufficient_balance', httpStatus: explicitStatus ?? 402 };
    }
    if (structuredFailureCode === 'MODEL_UNAVAILABLE') {
      return { ...base, category: 'model_not_found', httpStatus: explicitStatus ?? 404 };
    }

    // mimo 额度用尽返回的就是 401 "Invalid API Key"（真机 2026-08-01），
    // 所以 401 与鉴权/余额信号同时出现时必须留在 auth；只有可区分的
    // 402/明确余额信号才能精确引导充值。
    if ((explicitStatus === 401 || hasStatus(401)) && (hasAuthSignal || hasBalanceSignal)) {
      return { ...base, category: 'auth', httpStatus: explicitStatus ?? 401 };
    }

    if (hasBalanceSignal) {
      return { ...base, category: 'insufficient_balance', httpStatus: explicitStatus ?? 402 };
    }

    // 纯鉴权失败：重试一万次也没用，单独一档，别混进「请重试一次」。
    // 小米 mimo 额度用尽返回的就是 401 "Invalid API Key"（真机 2026-08-01）。
    if (hasAuthSignal) {
      return { ...base, category: 'auth', httpStatus: explicitStatus ?? 401 };
    }

    if (normalized.includes('concurrency limit exceeded')) {
      return { ...base, category: 'concurrency', httpStatus: explicitStatus };
    }

    if (normalized === 'forbidden' || normalized === 'ai_apicallerror: forbidden' || hasStatus(403)) {
      return { ...base, category: 'forbidden', httpStatus: explicitStatus ?? 403 };
    }

    if (normalized === 'not found' || normalized === 'ai_apicallerror: not found' || hasStatus(404)) {
      return { ...base, category: 'model_not_found', httpStatus: explicitStatus ?? 404 };
    }

    if (normalized.includes('rate limit') || normalized.includes('too many requests') || hasStatus(429)) {
      return { ...base, category: 'rate_limited', httpStatus: explicitStatus ?? 429 };
    }

    if (
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('network') ||
      normalized.includes('fetch failed') ||
      normalized.includes('econnrefused') ||
      normalized.includes('econnreset') ||
      normalized.includes('enotfound')
    ) {
      return { ...base, category: 'network', httpStatus: explicitStatus };
    }
  }

  return { ...base, category: 'generic', httpStatus: explicitStatus };
}
