// ============================================================================
// Observe-mode gate (N-TRIGGER-OBSERVE-MODE)
// ----------------------------------------------------------------------------
// 事件自动化处于「仅观察」档时，它的运行会话被登记到这里。ToolExecutor 在审批 / 缓存 /
// 锁 / 派发之前问一次：本会话在观察档、且这次调用是对外副作用（EXTERNAL 判据
// isExternalSideEffectTool，或浏览器/电脑动作目录里 consequence = external_side_effect）
// → 不执行、不弹审批卡、不消耗无人值守额度，交给登记方的 sink 记一条 would_act，
// 工具拿到「已记录、未执行」的结果。
// 这是在既有审批之上**额外加的一道 deny**：不在观察档 / 不是对外副作用的调用原样放过，
// 本模块从不放行任何东西。判定在宿主执行路径，不靠系统提示词。
// ============================================================================

import { CRON_EVENT_DECISIONS } from '../../shared/constants';
import {
  getStrictBrowserComputerActionCatalogForArgs,
  normalizeBrowserComputerCatalogToolName,
} from '../../shared/utils/browserComputerActionCatalog';
import { extractStandingGrantTarget, isExternalSideEffectTool } from './externalSideEffect';
import type { ToolExecutionResult } from './types';

/** 一次被拦下的对外动作：工具名 / 目标（取得到才有）/ 本会发出什么的一行摘要。 */
export interface ObserveModeInterception {
  toolName: string;
  target?: string;
  summary: string;
}

export type ObserveModeSink = (interception: ObserveModeInterception) => void;

const observedSessions = new Map<string, ObserveModeSink>();

/** 登记一个观察档运行会话；返回解除登记函数（运行收尾时调用）。 */
export function enterObserveMode(sessionId: string, sink: ObserveModeSink): () => void {
  observedSessions.set(sessionId, sink);
  return () => {
    if (observedSessions.get(sessionId) === sink) observedSessions.delete(sessionId);
  };
}

export function isSessionInObserveMode(sessionId: string | undefined): boolean {
  return sessionId !== undefined && observedSessions.has(sessionId);
}

/** 观察档要拦的调用：EXTERNAL 出站工具，或后果目录里标为对外副作用的浏览器/电脑动作。 */
export function isObserveInterceptedToolCall(toolName: string, params: Record<string, unknown>): boolean {
  if (isExternalSideEffectTool(toolName)) return true;
  if (!normalizeBrowserComputerCatalogToolName(toolName)) return false;
  const entry = getStrictBrowserComputerActionCatalogForArgs({ toolName, arguments: params });
  return entry?.consequence === 'external_side_effect';
}

export function truncateObserveText(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, maxChars - 1)}…`;
}

const SUMMARY_FIELDS = ['subject', 'text', 'content', 'body', 'message', 'msg', 'action'] as const;

/** 「本会发出什么」：优先挑正文类字段（含 lark 的 data.*），否则退回入参 JSON。 */
function summarizeOutboundParams(params: Record<string, unknown>): string {
  const sources = [params, params.data, params.params]
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const parts: string[] = [];
  for (const source of sources) {
    for (const field of SUMMARY_FIELDS) {
      const value = source[field];
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
  }
  let raw = parts.join(' — ');
  if (!raw) {
    try { raw = JSON.stringify(params); } catch { raw = ''; }
  }
  return truncateObserveText(raw, CRON_EVENT_DECISIONS.MAX_SUMMARY_CHARS);
}

/**
 * ToolExecutor 入口：本会话在观察档且调用是对外副作用 → 记 would_act 并返回「已记录、
 * 未执行」结果；否则返回 null（照常走既有审批与执行链）。
 */
export function interceptObserveModeToolCall(
  sessionId: string | undefined,
  toolName: string,
  params: Record<string, unknown>,
): ToolExecutionResult | null {
  if (sessionId === undefined) return null;
  const sink = observedSessions.get(sessionId);
  if (!sink || !isObserveInterceptedToolCall(toolName, params)) return null;
  const target = isExternalSideEffectTool(toolName)
    ? extractStandingGrantTarget(toolName, params) ?? undefined
    : undefined;
  const interception: ObserveModeInterception = {
    toolName,
    ...(target ? { target } : {}),
    summary: summarizeOutboundParams(params),
  };
  try {
    sink(interception);
  } catch (error) {
    // 记账失败不得让调用放行：照样拦下，只留痕。
    console.error(`[ObserveModeGate] failed to record would_act for ${toolName} (session=${sessionId}):`, error);
  }
  return {
    success: true,
    output: `${toolName}: ${CRON_EVENT_DECISIONS.OBSERVE_RECORDED_TEXT}. `
      + 'This automation is in observe mode: nothing was sent. The intended action was logged for the user to review.',
    metadata: { code: 'OBSERVE_MODE_RECORDED', observeMode: true, executionStarted: false },
  };
}
