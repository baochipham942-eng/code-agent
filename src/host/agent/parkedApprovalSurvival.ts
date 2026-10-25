// ============================================================================
// 停车审批的跨重启存活判据（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME）
// ============================================================================
//
// A′ 方案的数据面：一条 tool_approval 停车行想活过重启，必须同时满足——
//   ① 距 requestedAt 不到 24h（与 parkApproval 的 24h 兜底同一常量，不另立真源）；
//   ② argsRef（sessionId + toolCallId）+ argsFingerprint + ledgerFaithful===true 都在；
//   ③ 台账里真有承载该 toolCallId 的 assistant 消息，且还没有 tool result。
// 任何一条不满足 → fail-closed 收口（expired_after_restart_24h / args_unavailable），
// 绝不留一张「看着能点、点了被拒」的死卡。
//
// 本模块是纯函数：指纹/判据全在这里，startupMaintenance、hydrate、点击恢复三处共用同一口径。
// ============================================================================

import { createHash } from 'node:crypto';
import type { Message } from '../../shared/contract';
import type { ToolApprovalPayload } from '../../shared/contract/pendingApproval';
import { INTERACTION_TIMEOUTS } from '../../shared/constants';
import { sanitizeToolCallsForHistory } from './messageHandling/converter';
import { persistedToolCall, toolResultEvidence } from '../runtime/ledgerToolExecution';

/** 存活窗口 = 停车审批的 24h 兜底，同一常量避免两处 24h 漂移。 */
const PARKED_APPROVAL_SURVIVAL_WINDOW_MS = INTERACTION_TIMEOUTS.PARKED_APPROVAL;

/**
 * canonical JSON：对象键递归排序后序列化。指纹比对必须与键序无关——台账里的 args 来自
 * JSON.parse（保留落库键序），执行器手里的 args 来自模型流式装配，同内容不同键序是常态。
 * undefined 值按 JSON 语义丢弃（JSON.stringify 就会丢，落库侧没有 undefined）。
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(',')}}`;
}

/** 台账形参数（sanitizeToolCallsForHistory 输出）的 canonical sha256 指纹。 */
export function hashLedgerFormArgs(args: Record<string, unknown> | undefined): string {
  return createHash('sha256').update(canonicalJsonStringify(args)).digest('hex');
}

/**
 * 执行器侧的存活原料计算：对「这台工具现在真会拿去执行的参数」取账本形
 * （与 messageProcessor 落库前同一套 sanitize），算指纹并判定忠实性。
 * ledgerFaithful=false（sanitize 改动了 args，如 Write 大文本截断）→ 行不可存活。
 */
export function computeLedgerArgsSurvival(
  toolName: string,
  args: Record<string, unknown>,
): { argsFingerprint: string; ledgerFaithful: boolean } {
  const ledgerForm = sanitizeToolCallsForHistory([{
    id: 'parked-approval-survival-probe',
    name: toolName,
    arguments: args,
  }])?.[0]?.arguments ?? args;
  return {
    argsFingerprint: hashLedgerFormArgs(ledgerForm),
    ledgerFaithful: canonicalJsonStringify(args) === canonicalJsonStringify(ledgerForm),
  };
}

/** 行 shape 判据（不读台账）：年龄 + argsRef + 指纹 + 忠实标记。同步调用方的快速门。 */
export function isSurvivalShapedPayload(
  payload: unknown,
  now: number,
): payload is ToolApprovalPayload & {
  argsRef: { sessionId: string; toolCallId: string };
  argsFingerprint: string;
} {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<ToolApprovalPayload>;
  const requestedAt = typeof candidate.requestedAt === 'number' ? candidate.requestedAt : 0;
  if (now - requestedAt >= PARKED_APPROVAL_SURVIVAL_WINDOW_MS) return false;
  const ref = candidate.argsRef;
  if (!ref || typeof ref.sessionId !== 'string' || !ref.sessionId
    || typeof ref.toolCallId !== 'string' || !ref.toolCallId) return false;
  return typeof candidate.argsFingerprint === 'string' && candidate.argsFingerprint.length > 0
    && candidate.ledgerFaithful === true;
}

export type ParkedToolApprovalSurvival =
  | { survive: true; sessionId: string; toolCallId: string; argsFingerprint: string }
  | { survive: false; reason: 'expired_after_restart_24h' | 'args_unavailable' };

/**
 * 完整存活判据（读台账）。年龄先行：过 24h 的行无论参数好坏都报 expired_after_restart_24h；
 * 其余任何一条不满足（无 argsRef / 无指纹 / 不忠实 / 台账缺消息 / 已有结果）都报 args_unavailable。
 */
export function classifyParkedToolApprovalForSurvival(input: {
  payload: unknown;
  now: number;
  messages: Message[] | null;
}): ParkedToolApprovalSurvival {
  const payload = input.payload as Partial<ToolApprovalPayload> | null;
  if (!payload || typeof payload !== 'object') {
    return { survive: false, reason: 'args_unavailable' };
  }
  const requestedAt = typeof payload.requestedAt === 'number' ? payload.requestedAt : 0;
  if (input.now - requestedAt >= PARKED_APPROVAL_SURVIVAL_WINDOW_MS) {
    return { survive: false, reason: 'expired_after_restart_24h' };
  }
  if (!isSurvivalShapedPayload(payload, input.now)) {
    return { survive: false, reason: 'args_unavailable' };
  }
  if (!input.messages) {
    return { survive: false, reason: 'args_unavailable' };
  }
  const persisted = persistedToolCall(input.messages, payload.argsRef.toolCallId);
  if (!persisted) {
    return { survive: false, reason: 'args_unavailable' };
  }
  if (toolResultEvidence(input.messages, payload.argsRef.toolCallId)) {
    return { survive: false, reason: 'args_unavailable' };
  }
  return {
    survive: true,
    sessionId: payload.argsRef.sessionId,
    toolCallId: payload.argsRef.toolCallId,
    argsFingerprint: payload.argsFingerprint,
  };
}

/** 安全解析 payloadJson；坏行当 null 处理（判据侧全部落 args_unavailable）。 */
export function parseParkedApprovalPayload(payloadJson: string): Partial<ToolApprovalPayload> | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Partial<ToolApprovalPayload> : null;
  } catch {
    return null;
  }
}

/**
 * startupMaintenance 用的会话内幸存 toolCall 集合：该 session 的 pending tool_approval 行里
 * 真正能活过重启的 toolCallId（这些调用不写 INTERRUPTED 占位，留给批准后真执行）。
 */
export function listSurvivingParkedToolCallIds(
  rows: Array<{ payloadJson: string }>,
  sessionId: string,
  messages: Message[],
  now: number,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const payload = parseParkedApprovalPayload(row.payloadJson);
    const rowSession = payload?.argsRef?.sessionId ?? payload?.sessionId;
    if (rowSession !== sessionId) continue;
    const verdict = classifyParkedToolApprovalForSurvival({ payload, now, messages });
    if (verdict.survive) ids.add(verdict.toolCallId);
  }
  return ids;
}
