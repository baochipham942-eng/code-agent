import {
  getRunInterruptCause,
  MAX_AUTO_RESUME_COUNT,
  type PendingOperation,
  type RunEnvelope,
} from '../../shared/contract/durableRun';
import type { RunRegistry } from './runRegistry';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RecoveredWaitingRun');

/**
 * Recovered waiting native runs have an owner lease but no control handle.
 * They block a new root run on the same session until cancelled.
 */
export function findRecoveredWaitingRun(
  envelopes: Iterable<RunEnvelope>,
  hasHandle: (runId: string) => boolean,
  hasOwner: (runId: string) => boolean,
  selector: { runId?: string; sessionId?: string },
): { runId: string; sessionId: string } | undefined {
  const runId = selector.runId?.trim();
  const sessionId = selector.sessionId?.trim();
  if (!runId && !sessionId) return undefined;
  for (const envelope of envelopes) {
    if (envelope.status !== 'waiting') continue;
    if (runId && envelope.runId !== runId) continue;
    if (sessionId && envelope.sessionId !== sessionId) continue;
    if (!runId && envelope.parentRunId) continue;
    if (hasHandle(envelope.runId) || !hasOwner(envelope.runId)) continue;
    return { runId: envelope.runId, sessionId: envelope.sessionId };
  }
  return undefined;
}

/**
 * 手动「继续」由新的 live loop 接管这一轮：停靠时残留的在途模型调用（预算耗尽停靠不做 fence）
 * 必须同笔收口，否则这轮结束时 completed 被「存在未决 op」拒写、run 永远落不了终态。
 * 工具类 op 不动（未知写不重放，K2 语义）。
 */
export function settleModelOpsForManualContinue(operations: PendingOperation[], now: number): PendingOperation[] {
  return operations.map((operation) => (
    operation.kind === 'model_call' && ['prepared', 'dispatched', 'unknown'].includes(operation.status)
      ? { ...operation, status: 'abandoned' as const, resultRef: `model-recovery:superseded-by-manual-continue:${operation.operationId}`, updatedAt: now }
      : operation
  ));
}

/**
 * 新消息优先（ADR-075 修订 2026-09-29 ③⑤）：同会话里本进程持有、无活 handle 的根 run，
 * 若是等「继续」的停靠 run（user_stop / guard_halt / 预算耗尽）或还在后台排队的自动续跑，
 * 就该让位给新一轮。等审批的 waiting（crash 且预算未耗尽）不在此列，仍按原冲突语义。
 */
export function findSupersededSessionRoots(
  envelopes: Iterable<RunEnvelope>,
  hasHandle: (runId: string) => boolean,
  isQueued: (runId: string) => boolean,
  sessionId: string,
): RunEnvelope[] {
  return [...envelopes].filter((envelope) => {
    if (envelope.sessionId !== sessionId || envelope.parentRunId || hasHandle(envelope.runId)) return false;
    if (envelope.status === 'recovering') return isQueued(envelope.runId);
    if (envelope.status !== 'waiting') return false;
    const cause = getRunInterruptCause(envelope);
    return cause !== undefined
      && (cause !== 'crash_or_quit' || (envelope.autoResumeCount ?? 0) >= MAX_AUTO_RESUME_COUNT);
  });
}

type RecoveredWaitingCancel = { runId: string; sessionId: string };

/** 把 findRecoveredWaitingRun 命中的 run 沿 terminalDurable 规范路径（owner/attempt fence + 事件序号）终态化成 cancelled。 */
export function terminalRecoveredWaitingRunOnce(
  registry: Pick<RunRegistry, 'findRecoveredWaitingRun' | 'terminalDurable'>,
  inFlightCancels: Map<string, Promise<RecoveredWaitingCancel>>,
  selector: { runId?: string; sessionId?: string },
  now: number,
): Promise<(RecoveredWaitingCancel & { joined?: true }) | undefined> {
  const recovered = registry.findRecoveredWaitingRun(selector);
  if (!recovered) return Promise.resolve(undefined);
  // 桌面「放弃」与手机「停止」可能同时到：两边都在终态提交前查到了它。后到的一方
  // 并到同一次提交上，而不是再提交一次撞 cancelled -> cancelled 冲突抛错（桌面 500）。
  // joined 标给后到者：终态事件只由真正提交的一方补发，手机不会收两条 agent_cancelled。
  const inFlight = inFlightCancels.get(recovered.runId);
  if (inFlight) return inFlight.then((settled) => ({ ...settled, joined: true as const }));
  const cancel = registry.terminalDurable(recovered.runId, {
    now,
    status: 'cancelled',
    reason: 'recovered_waiting_run_cancelled',
    event: {
      type: 'run_cancelled',
      payload: { sessionId: recovered.sessionId, reason: 'recovered_waiting_run_cancelled' },
      recordedAt: now,
    },
  }).then(() => recovered).finally(() => {
    inFlightCancels.delete(recovered.runId);
  });
  inFlightCancels.set(recovered.runId, cancel);
  return cancel;
}

/**
 * 新一轮建 durable 根 run 前，把 findSupersededSessionRoots 选出的旧 run 终态化，否则它占着活跃
 * 会话唯一约束：web /api/run 会 409、桌面会回落成非 durable。停靠的走 terminalRecoveredWaitingRun
 * （与「放弃」/手机「停止」并发时合并成一次提交），排队的直接 terminalDurable。
 */
export async function supersedeSessionRoots(
  registry: Pick<RunRegistry, 'terminalRecoveredWaitingRun' | 'terminalDurable'>,
  superseded: RunEnvelope[],
  sessionId: string,
  now: number,
): Promise<void> {
  for (const { runId, status } of superseded) {
    const payload = { sessionId, reason: 'superseded_by_new_message' };
    await (status === 'waiting'
      ? registry.terminalRecoveredWaitingRun({ runId }, now)
      : registry.terminalDurable(runId, { now, status: 'cancelled', reason: payload.reason, event: { type: 'run_cancelled', payload, recordedAt: now } })
    ).catch((error: unknown) => logger.warn('Failed to supersede parked durable run', {
      sessionId, runId, error: error instanceof Error ? error.message : String(error),
    }));
  }
}
