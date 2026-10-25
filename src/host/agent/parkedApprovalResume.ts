// ============================================================================
// 重启后停车审批的「批准 → 从台账执行一次」（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME）
// ============================================================================
//
// 宿主进程重启后，幸存的 tool_approval 行没有内存 Promise 可 resolve；这里的语义是
// A′（owner 10-17 拍板）：不投 durable approval op、不续跑 run——
//   允许：重读台账调用 → 重算指纹（不符 → args_unavailable 收口）→ 结果已存在则跳过 →
//         会话工作目录可恢复（解析不出 → args_unavailable 收口，绝不回退家目录）→
//         原子认领（pending→approved，UPDATE changes==1 者赢）→ 经与
//         nativeRecoveryHost.approval.dispatchPrepared 共享的执行器真执行一次 →
//         结果消息落回原会话。
//   拒绝：认领成 rejected + 台账落 denied 结果消息，什么都不执行。
// 认领必须先于执行：并发/重复点击只有认领赢家走到执行器，at-most-once。
// 认领后、结果落盘前崩溃：行已是 approved，后续点击按非候选直接返回，永不二次执行。
// ============================================================================

import type { Message, PermissionResponse } from '../../shared/contract';
import type { PendingApprovalRecord } from '../../shared/contract/pendingApproval';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { ToolExecutor } from '../tools/toolExecutor';
import {
  dispatchLedgerToolApproval,
  rejectLedgerToolApproval,
  toolResultEvidence,
  type LedgerToolExecutionPorts,
} from '../runtime/ledgerToolExecution';
import {
  classifyParkedToolApprovalForSurvival,
  hashLedgerFormArgs,
  isSurvivalShapedPayload,
  parseParkedApprovalPayload,
} from './parkedApprovalSurvival';
import { sanitizeToolCallsForHistory } from './messageHandling/converter';

const logger = createLogger('ParkedApprovalResume');

/** 点击恢复的可注入依赖；生产缺省走 DB 单例 + 会话台账 + 真 ToolExecutor。 */
export interface ParkedApprovalResumePorts extends LedgerToolExecutionPorts {
  repo: PendingApprovalRepository;
  loadMessages(sessionId: string): Message[] | null;
  /**
   * 解析会话工作目录。null = 解析不出安全的工作目录（会话记录缺失 / 没落过
   * workingDirectory / 查询失败）——上层必须 fail-closed 拒绝执行，绝不能静默
   * 回退家目录：相对路径命令会以错误的 cwd 落副作用（rework r1）。
   */
  resolveWorkingDirectory(sessionId: string): string | null | Promise<string | null>;
}

export type ParkedApprovalResumeOutcome =
  | { handled: false }
  | { handled: true; status: 'executed'; resultRef: string }
  | { handled: true; status: 'denied'; resultRef: string | null }
  | { handled: true; status: 'already_present'; resultRef: string }
  | { handled: true; status: 'lost_race' }
  | { handled: true; status: 'closed'; reason: 'expired_after_restart_24h' | 'args_unavailable' };

function defaultPorts(nowFn: () => number): ParkedApprovalResumePorts | null {
  let repo: PendingApprovalRepository;
  try {
    repo = getDatabase().getPendingApprovalRepo();
  } catch {
    return null;
  }
  return {
    repo,
    loadMessages(sessionId) {
      try {
        return getDatabase().getMessages(sessionId);
      } catch {
        return null;
      }
    },
    async resolveWorkingDirectory(sessionId) {
      try {
        // 与判据链同口径直读会话记录（loadMessages→getMessages 不带 owner 过滤）：
        // owner-scoped 查询在重启后可能因当前 owner 不匹配而错失会话，把可执行的
        // 行误判成「没有工作目录」；解析不出就返回 null 交给上层 fail-closed。
        const session = getDatabase().getSession(sessionId);
        return session?.workingDirectory || null;
      } catch (error) {
        logger.warn('Session working directory lookup failed for parked approval resume', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    // 用户已在收件箱批准——审批就是权限，这里的 requestPermission 恒 true
    // （与 nativeRecoveryHost 的恢复执行器同一先例）。
    async executeTool(input) {
      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: input.workingDirectory,
        ledgerOrigin: 'desktop',
      });
      return executor.execute(input.name, input.arguments, {
        sessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        currentToolCallId: input.toolCallId,
        turnId: input.toolCallId,
      });
    },
    async persistToolMessage(sessionId, message) {
      getDatabase().addMessage(sessionId, message, { provenanceKind: 'crash-recovery' });
    },
    now: nowFn,
  };
}

/** 行级候选判据（不读台账）：非候选 → false，调用方回落旧的 fail-closed 收口。 */
function isSurvivingParkedApprovalCandidate(
  repo: PendingApprovalRepository,
  requestId: string,
  now: number,
): boolean {
  let row: PendingApprovalRecord | null;
  try {
    row = repo.getById(requestId);
  } catch {
    return false;
  }
  if (row?.kind !== 'tool_approval' || row.status !== 'pending') return false;
  return isSurvivalShapedPayload(parseParkedApprovalPayload(row.payloadJson), now);
}

/**
 * 同步入口（desktop IPC 的 handlePermissionResponse 是同步签名）：候选行点火异步恢复，
 * 认领/执行/落盘都在恢复任务里完成。返回 true 表示这次点击已被接手。
 */
export function kickSurvivingParkedApprovalResume(
  requestId: string,
  response: PermissionResponse,
  now: number = Date.now(),
): boolean {
  let repo: PendingApprovalRepository;
  try {
    repo = getDatabase().getPendingApprovalRepo();
  } catch {
    return false;
  }
  if (!isSurvivingParkedApprovalCandidate(repo, requestId, now)) return false;
  void resumeSurvivingParkedApproval({ requestId, response, now })
    .catch((error: unknown) => logger.warn('Parked approval resume failed', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
}

/**
 * 异步入口（web 投递链可 await）：完整恢复。非候选行返回 { handled: false }，
 * 调用方继续走 closeDeadParkedApproval 等旧路径。
 */
export async function resumeSurvivingParkedApproval(input: {
  requestId: string;
  response: PermissionResponse;
  now?: number;
  ports?: ParkedApprovalResumePorts;
}): Promise<ParkedApprovalResumeOutcome> {
  const now = input.now ?? Date.now();
  const ports = input.ports ?? defaultPorts(() => now);
  if (!ports) return { handled: false };
  const { repo } = ports;

  let row: PendingApprovalRecord | null;
  try {
    row = repo.getById(input.requestId);
  } catch {
    return { handled: false };
  }
  if (row?.kind !== 'tool_approval' || row.status !== 'pending') {
    return { handled: false };
  }
  const payload = parseParkedApprovalPayload(row.payloadJson);
  if (!isSurvivalShapedPayload(payload, now)) return { handled: false };

  const sessionId = payload.argsRef.sessionId;
  const loadedMessages = ports.loadMessages(sessionId);
  const messages = loadedMessages ?? [];
  const verdict = classifyParkedToolApprovalForSurvival({ payload, now, messages });
  if (!verdict.survive) {
    // 重启 hydrate 本应已收口；迟到到达这里就按同一理由补收（pending-only，幂等）。
    repo.resolve({
      id: input.requestId,
      status: 'rejected',
      feedback: `Auto-rejected after restart: ${verdict.reason}`,
      resolvedAt: now,
    });
    logger.warn('Surviving parked approval turned out non-survivable on click', {
      requestId: input.requestId,
      reason: verdict.reason,
    });
    return { handled: true, status: 'closed', reason: verdict.reason };
  }

  const toolCallId = verdict.toolCallId;
  const deny = async (
    feedback: string,
    deniedReason: string,
    status: 'denied' | 'closed' = 'denied',
    reason?: 'expired_after_restart_24h' | 'args_unavailable',
  ): Promise<ParkedApprovalResumeOutcome> => {
    const changes = repo.resolve({
      id: input.requestId,
      status: 'rejected',
      feedback,
      resolvedAt: now,
    });
    if (changes === 0) return { handled: true, status: 'lost_race' };
    const outcome = await rejectLedgerToolApproval(ports, {
      messages,
      toolCallId,
      sessionId,
      reason: deniedReason,
    });
    if (status === 'closed') {
      return { handled: true, status: 'closed', reason: reason ?? 'args_unavailable' };
    }
    return { handled: true, status: 'denied', resultRef: outcome.status === 'payload_unavailable' ? null : outcome.resultRef };
  };

  if (input.response !== 'allow' && input.response !== 'allow_session' && input.response !== 'allow_standing') {
    return deny('rejected by user after restart', 'approval rejected by user after restart');
  }

  // 指纹复算（执行前置）：台账 args 重算 canonical 哈希，与停车时落盘的指纹比对——
  // 点的是 A、台账变出了 B（截断/漂移）就绝不执行（args_unavailable）。
  // 会话的 run 已停靠（guard_halt）、无在飞写入者，这一读就是点击时刻的权威快照。
  const persisted = messages.find((message) => (
    message.role === 'assistant'
    && message.toolCalls?.some((call) => call.id === toolCallId)
  ));
  const ledgerCall = persisted?.toolCalls?.find((call) => call.id === toolCallId);
  if (!persisted || !ledgerCall) {
    return deny('Auto-rejected after restart: args_unavailable', 'approval rejected: ledger args unavailable after restart');
  }
  const recomputedFingerprint = hashLedgerFormArgs(
    sanitizeLedgerArgsForFingerprint(ledgerCall.name, ledgerCall.arguments),
  );
  if (recomputedFingerprint !== verdict.argsFingerprint) {
    logger.warn('Surviving parked approval fingerprint mismatch', { requestId: input.requestId, toolCallId });
    return deny(
      'Auto-rejected after restart: args_unavailable',
      'approval rejected: ledger args changed after restart (args_unavailable)',
      'closed',
      'args_unavailable',
    );
  }

  // 台账已有结果（崩溃前其实执行过 / 别的路径补过）：收口为 approved 并注明未重放。
  const existingEvidence = toolResultEvidence(messages, toolCallId);
  if (existingEvidence) {
    const changes = repo.resolve({
      id: input.requestId,
      status: 'approved',
      feedback: 'tool result already present; not re-executed',
      resolvedAt: now,
    });
    return changes === 0
      ? { handled: true, status: 'lost_race' }
      : { handled: true, status: 'already_present', resultRef: existingEvidence.resultRef };
  }

  // 工作目录必须可恢复才允许执行：解析不出会话工作目录（记录缺失 / 没落过 cwd）就
  // fail-closed 收口 args_unavailable，绝不静默回退家目录——相对路径命令会落错目录。
  // 放在原子认领之前：resolve 是 pending-only，认领后再想拒只会 lost_race 收不了口。
  const workingDirectory = await ports.resolveWorkingDirectory(sessionId);
  if (!workingDirectory) {
    logger.warn('Surviving parked approval cannot resolve session working directory; refusing to execute', {
      requestId: input.requestId,
      sessionId,
    });
    return deny(
      'Auto-rejected after restart: args_unavailable',
      'approval rejected: session working directory unavailable after restart (args_unavailable)',
      'closed',
      'args_unavailable',
    );
  }

  // 原子认领（pending→approved，UPDATE changes==1 者赢）：认领必须先于执行——
  // 并发/重复点击里只有赢家走到 dispatchLedgerToolApproval，at-most-once 由此保证。
  // 认领后、结果落盘前崩溃：行已是 approved，后续点击按非候选直接返回，永不重执行。
  const claimed = repo.resolve({
    id: input.requestId,
    status: 'approved',
    feedback: 'approved after restart',
    resolvedAt: now,
  });
  if (claimed === 0) {
    logger.info('Parked approval already claimed by another responder', { requestId: input.requestId });
    return { handled: true, status: 'lost_race' };
  }

  let outcome;
  try {
    outcome = await dispatchLedgerToolApproval(ports, {
      messages,
      toolCallId,
      sessionId,
      workingDirectory,
    });
  } catch (error) {
    // 执行层抛错（非工具级失败）：行已认领，给台账补一条失败结果，别让 toolCall 悬空。
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Parked approval execution threw after claim', { requestId: input.requestId, message });
    await rejectLedgerToolApproval(ports, {
      messages,
      toolCallId,
      sessionId,
      reason: `approval execution failed after restart: ${message}`,
    }).catch(() => undefined);
    return { handled: true, status: 'denied', resultRef: null };
  }
  if (outcome.status === 'payload_unavailable') {
    return deny('Auto-rejected after restart: args_unavailable', 'approval rejected: ledger args unavailable after restart');
  }
  if (outcome.status === 'already_present') {
    return { handled: true, status: 'already_present', resultRef: outcome.resultRef };
  }
  logger.info('Parked approval executed once from message ledger', {
    requestId: input.requestId,
    sessionId,
    toolCallId,
  });
  return { handled: true, status: 'executed', resultRef: outcome.resultRef };
}

function sanitizeLedgerArgsForFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // 与 computeLedgerArgsSurvival 同一账本形（sanitize 幂等：台账 args 本就是 sanitize 过的）。
  return sanitizeToolCallsForHistory([{ id: 'resume-fingerprint-probe', name: toolName, arguments: args }])?.[0]?.arguments ?? args;
}
