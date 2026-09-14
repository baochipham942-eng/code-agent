// ============================================================================
// 后台 subagent 注册表 — 进程内后台执行 + 稳定 agent_id（Kimi 借鉴 #2 / ADR-025）
// ============================================================================
// Kimi AgentSwarm 的 run_in_background：子 agent 后台跑、返稳定 agent_id、前台
// 不阻塞、可查/取结果。ADR-025 拍 A1（后台执行 only，不跨重启 resume）；A2 的
// 断点续跑仍不做，但 N-BGSPAWN-DURABLE 起 spawn/adopt 会同步落 durable 账本
// （backgroundSubagentDurableLedger），崩溃重启后由启动恢复收口成
// interrupted_by_restart 并投影中断事实回父会话——钱和执行事实不再随进程蒸发。
//
// spawn(run) 立刻返回稳定 agentId、不 await run；run 在后台跑，resolve/reject
// 时回填状态与结果。getStatus / await 凭 agentId 查状态、取结果。
// ============================================================================

import { randomUUID } from 'node:crypto';
import type { SubagentResult } from './subagentExecutorTypes';
import { AgentFailureCode, inferAgentFailureCode, type AgentFailureCode as AgentFailureCodeType } from '../../shared/contract/agentFailure';
import { createLogger } from '../services/infra/logger';
import {
  getBackgroundSubagentDurableLedger,
  isBackgroundSubagentDurableArmed,
  waitForBackgroundSubagentDurableLedger,
  type BackgroundSubagentDurableLedger,
} from './backgroundSubagentDurableLedger';
import {
  buildSubagentCompletionRecord,
  type SubagentCompletionKind,
  type SubagentCompletionRecord,
} from './subagentCompletionNotification';

const logger = createLogger('BackgroundSubagentRegistry');

export type BackgroundSubagentStatus = 'running' | 'completed' | 'failed';

export interface BackgroundSubagentHandle {
  agentId: string;
  title?: string;
  completionKind?: SubagentCompletionKind;
  status: BackgroundSubagentStatus;
  sessionId?: string;
  runId?: string;
  treeId?: string;
  role?: string;
  declaredOutputs?: string[];
  result?: SubagentResult;
  error?: string;
  failureCode?: AgentFailureCodeType;
  startedAt: number;
  finishedAt?: number;
}

interface BackgroundSubagentEntry extends BackgroundSubagentHandle {
  /** 后台 run 的 promise——await(agentId) 复用它，不重复触发。 */
  done: Promise<SubagentResult | undefined>;
}

export interface BackgroundSubagentScopeFilter {
  sessionId: string;
  runId?: string;
  treeId?: string;
}

export interface BackgroundSubagentOptions {
  agentId?: string;
  title?: string;
  completionKind?: SubagentCompletionKind;
  sessionId?: string;
  runId?: string;
  treeId?: string;
  role?: string;
  declaredOutputs?: string[];
  suppressIdleWake?: boolean;
  suppressReason?: 'block-wait' | 'cancelled' | 'goal-loop';
  onComplete?: (record: SubagentCompletionRecord) => void | Promise<void>;
}

export class BackgroundSubagentRegistry {
  private readonly entries = new Map<string, BackgroundSubagentEntry>();
  private readonly pendingNotifications: SubagentCompletionRecord[] = [];
  private readonly queuedNotificationKeys = new Set<string>();
  private readonly now: () => number;

  // now 注入便于测试；默认墙钟。本类非 DB 写路径，不受 repository Date.now 禁令约束。
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 后台跑 run，立即返回稳定 agentId，不阻塞调用方。 */
  spawn(run: () => Promise<SubagentResult>, options: BackgroundSubagentOptions = {}): string {
    // ADR-025 B1：持久随机 id（也是 durable run_id）。保留 subagent-bg- 前缀——
    // collect_agent schema 文案等消费方按此前缀描述 id 形态。
    const agentId = options.agentId ?? `subagent-bg-${randomUUID()}`;
    const startedAt = this.now();
    const durableSession = this.beginDurable(agentId, options, startedAt);
    const done = this.attachCompletion(agentId, (async (): Promise<SubagentResult> => {
      // 先落账再花钱：durable 模式下账本不就绪时这里直接 reject，子代理不会启动。
      await durableSession;
      return run();
    })(), {
      ...options,
      agentId,
      startedAt,
      durableSession,
    });

    this.entries.set(agentId, {
      agentId,
      status: 'running',
      startedAt,
      done,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.treeId ? { treeId: options.treeId } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.completionKind ? { completionKind: options.completionKind } : {}),
      ...(options.declaredOutputs && options.declaredOutputs.length > 0
        ? { declaredOutputs: options.declaredOutputs }
        : {}),
    });
    return agentId;
  }

  adopt(promise: Promise<SubagentResult>, options: BackgroundSubagentOptions & { agentId: string; startedAt?: number }):
  string {
    const existing = this.entries.get(options.agentId);
    if (existing?.status === 'running') {
      throw new Error(`Background subagent already running: ${options.agentId}`);
    }
    const startedAt = options.startedAt ?? this.now();
    const durableSession = this.beginDurable(options.agentId, options, startedAt);
    const done = this.attachCompletion(options.agentId, (async (): Promise<SubagentResult> => {
      await durableSession;
      return promise;
    })(), {
      ...options,
      startedAt,
      durableSession,
    });

    this.entries.set(options.agentId, {
      agentId: options.agentId,
      status: 'running',
      startedAt,
      done,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.treeId ? { treeId: options.treeId } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.completionKind ? { completionKind: options.completionKind } : {}),
      ...(options.declaredOutputs && options.declaredOutputs.length > 0
        ? { declaredOutputs: options.declaredOutputs }
        : {}),
    });
    return options.agentId;
  }

  /**
   * durable 账本落行。返回的 promise 在「落账完成」时 resolve（legacy 模式 / 无
   * sessionId 时为 null，纯内存路径，行为与改造前一致）。armed 但 kernel 未就绪
   * 时等待 configure，超时 fail-closed（见 backgroundSubagentDurableLedger）。
   * parentRunId 缺失时落账会让这条 run 占住 session 的活跃根 run 唯一位，跳过。
   */
  private beginDurable(
    agentId: string,
    options: BackgroundSubagentOptions,
    startedAt: number,
  ): Promise<BackgroundSubagentDurableLedger | null> | null {
    if (!options.sessionId) return null;
    if (!options.runId) {
      logger.warn(`background subagent ${agentId} has no parent runId; skipping durable ledger`);
      return null;
    }
    const input = {
      agentId,
      sessionId: options.sessionId,
      parentRunId: options.runId,
      ...(options.title ? { title: options.title } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.treeId ? { treeId: options.treeId } : {}),
      ...(options.completionKind ? { completionKind: options.completionKind } : {}),
      startedAt,
    };
    const ledger = getBackgroundSubagentDurableLedger();
    if (ledger) return ledger.begin(input).then(() => ledger);
    if (!isBackgroundSubagentDurableArmed()) return null;
    return waitForBackgroundSubagentDurableLedger().then((ready) => ready.begin(input).then(() => ready));
  }

  private async finalizeDurable(
    durableSession: Promise<BackgroundSubagentDurableLedger | null> | null,
    entry: BackgroundSubagentEntry,
  ): Promise<void> {
    if (!durableSession) return;
    let ledger: BackgroundSubagentDurableLedger | null;
    try {
      ledger = await durableSession;
    } catch {
      return; // 落账本身就失败了，没有行可收。
    }
    if (!ledger) return;
    const cancelled = entry.failureCode === AgentFailureCode.CancelledByUser
      || entry.failureCode === AgentFailureCode.CancelledByParent
      || Boolean(entry.result?.cancellationReason);
    const outcome = entry.status === 'completed' ? 'completed' : cancelled ? 'cancelled' : 'failed';
    try {
      await ledger.finalize(entry.agentId, {
        outcome,
        ...(entry.error ? { reason: entry.error } : {}),
        ...(entry.result?.cost !== undefined ? { cost: entry.result.cost } : {}),
        ...(entry.result?.tokensUsed !== undefined ? { tokensUsed: entry.result.tokensUsed } : {}),
        ...(entry.result?.iterations !== undefined ? { iterations: entry.result.iterations } : {}),
        finishedAt: entry.finishedAt ?? this.now(),
      });
    } catch (error) {
      // 终态写失败：内存态与通知不受影响；账本行保持 running，由 sweeper / 下次
      // 启动收口成 interrupted_by_restart（fail-closed 方向，宁可误报中断）。
      logger.warn(`background subagent ${entry.agentId} durable finalize failed:`, error);
    }
  }

  private attachCompletion(
    agentId: string,
    promise: Promise<SubagentResult>,
    options: BackgroundSubagentOptions & {
      startedAt: number;
      durableSession?: Promise<BackgroundSubagentDurableLedger | null> | null;
    },
  ): Promise<SubagentResult | undefined> {
    return (async (): Promise<SubagentResult | undefined> => {
      try {
        const result = await promise;
        const entry = this.entries.get(agentId);
        if (entry) {
          entry.status = result.success ? 'completed' : 'failed';
          entry.result = result;
          if (!result.success) {
            entry.error = result.error ?? 'Subagent failed';
            entry.failureCode = inferAgentFailureCode({
              failureCode: result.failureCode,
              cancellationReason: result.cancellationReason,
              error: result.error,
            });
          }
          entry.finishedAt = this.now();
          this.recordCompletion(entry, options);
          await this.finalizeDurable(options.durableSession ?? null, entry);
        }
        return result;
      } catch (err) {
        const entry = this.entries.get(agentId);
        if (entry) {
          entry.status = 'failed';
          entry.error = err instanceof Error ? err.message : String(err);
          entry.failureCode = inferAgentFailureCode({ error: err, defaultCode: undefined });
          entry.finishedAt = this.now();
          this.recordCompletion(entry, options);
          await this.finalizeDurable(options.durableSession ?? null, entry);
        }
        return undefined;
      }
    })();
  }

  private recordCompletion(entry: BackgroundSubagentEntry, options: BackgroundSubagentOptions): void {
    const record = buildSubagentCompletionRecord({
      agentId: entry.agentId,
      title: entry.title,
      role: entry.role,
      kind: entry.completionKind,
      status: entry.status === 'completed' ? 'completed' : 'failed',
      output: entry.result?.output,
      error: entry.error,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      failureCode: entry.failureCode,
      missingTools: entry.result?.missingTools,
      toolsUsed: entry.result?.toolsUsed,
      iterations: entry.result?.iterations,
      cost: entry.result?.cost,
      sessionId: entry.sessionId,
      runId: entry.runId,
      treeId: entry.treeId,
    });
    if (!this.queuedNotificationKeys.has(record.dedupeKey)) {
      this.queuedNotificationKeys.add(record.dedupeKey);
      this.pendingNotifications.push(record);
    }
    const cancelled = entry.failureCode === AgentFailureCode.CancelledByUser
      || entry.failureCode === AgentFailureCode.CancelledByParent;
    if (!options.suppressIdleWake && !cancelled) {
      void options.onComplete?.(record);
    }
  }

  /** 凭 agentId 查当前状态快照（不含内部 promise）。未知 id 返回 undefined。 */
  getStatus(agentId: string): BackgroundSubagentHandle | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    const { done: _done, ...handle } = entry;
    return { ...handle };
  }

  /** 等待后台 subagent 完成并取结果。未知 id 返回 undefined；失败返回 undefined。 */
  async await(agentId: string): Promise<SubagentResult | undefined> {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    return entry.done;
  }

  /** 当前所有后台 subagent 的状态快照（UI/诊断用）。 */
  list(): BackgroundSubagentHandle[] {
    return [...this.entries.values()].map(({ done: _done, ...handle }) => ({ ...handle }));
  }

  /**
   * N-BGSPAWN-DURABLE 启动恢复投影：子代理的 durable 行在上个进程崩溃时还是
   * running，本进程把它收口成 interrupted 后，由这里向父会话补一条中断事实，
   * 复用正常完成通知的同一条 pendingNotifications 管道（toolExecutionEngine
   * drain / idle wake 都能看到）。只在收口成功后调用；dedupeKey 去重。
   */
  recordInterruptedCompletion(input: {
    agentId: string;
    title?: string;
    role?: string;
    completionKind?: SubagentCompletionKind;
    sessionId?: string;
    runId?: string;
    treeId?: string;
    startedAt?: number;
    cost?: number;
  }): SubagentCompletionRecord {
    const record = buildSubagentCompletionRecord({
      agentId: input.agentId,
      title: input.title,
      role: input.role,
      kind: input.completionKind,
      status: 'failed',
      error: 'Background subagent was interrupted by an application restart before it finished '
        + '(interrupted_by_restart). Its final result is unavailable; inspect the session and '
        + 'decide whether to spawn it again.',
      startedAt: input.startedAt,
      finishedAt: this.now(),
      failureCode: AgentFailureCode.ParentGone,
      cost: input.cost,
      sessionId: input.sessionId,
      runId: input.runId,
      treeId: input.treeId,
    });
    if (!this.queuedNotificationKeys.has(record.dedupeKey)) {
      this.queuedNotificationKeys.add(record.dedupeKey);
      this.pendingNotifications.push(record);
    }
    // 同时补一条终态 entry：重启后父模型按通知里的 next_action 调 collect_agent
    // 时能拿到 failed/interrupted 事实，而不是「Unknown background agent」。
    if (!this.entries.has(input.agentId)) {
      const startedAt = input.startedAt ?? this.now();
      this.entries.set(input.agentId, {
        agentId: input.agentId,
        status: 'failed',
        startedAt,
        finishedAt: this.now(),
        error: 'interrupted_by_restart: background subagent was interrupted by an application restart',
        failureCode: AgentFailureCode.ParentGone,
        done: Promise.resolve(undefined),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.treeId ? { treeId: input.treeId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.completionKind ? { completionKind: input.completionKind } : {}),
      });
    }
    return record;
  }

  drainCompletionNotifications(scope?: BackgroundSubagentScopeFilter): SubagentCompletionRecord[] {
    if (this.pendingNotifications.length === 0) return [];
    const matched: SubagentCompletionRecord[] = [];
    const remaining: SubagentCompletionRecord[] = [];

    for (const record of this.pendingNotifications) {
      if (!this.matchesScope(record, scope)) {
        remaining.push(record);
        continue;
      }
      matched.push(record);
    }
    this.pendingNotifications.length = 0;
    this.pendingNotifications.push(...remaining);
    return matched;
  }

  private matchesScope(record: SubagentCompletionRecord, scope?: BackgroundSubagentScopeFilter): boolean {
    if (!scope) return true;
    if (!record.sessionId) return !scope.runId && record.treeId === scope.sessionId;
    if (record.sessionId !== scope.sessionId) return false;
    if (scope.runId && record.runId !== scope.runId) return false;
    return !scope.treeId || record.treeId === scope.treeId;
  }
}

let singleton: BackgroundSubagentRegistry | null = null;

export function getBackgroundSubagentRegistry(): BackgroundSubagentRegistry {
  if (!singleton) {
    singleton = new BackgroundSubagentRegistry();
  }
  return singleton;
}
