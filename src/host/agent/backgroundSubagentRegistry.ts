// ============================================================================
// 后台 subagent 注册表 — 进程内后台执行 + 稳定 agent_id（Kimi 借鉴 #2 / ADR-025 A1）
// ============================================================================
// Kimi AgentSwarm 的 run_in_background：子 agent 后台跑、返稳定 agent_id、前台
// 不阻塞、可查/取结果。ADR-025 拍 A1（后台执行 only，不跨重启 resume），故用
// **进程内内存注册表**即可——backgroundTask 的 DB 持久层留给二期 A2（跨重启）。
//
// spawn(run) 立刻返回稳定 agentId、不 await run；run 在后台跑，resolve/reject
// 时回填状态与结果。getStatus / await 凭 agentId 查状态、取结果。
// ============================================================================

import type { SubagentResult } from './subagentExecutorTypes';
import { AgentFailureCode, inferAgentFailureCode, type AgentFailureCode as AgentFailureCodeType } from '../../shared/contract/agentFailure';
import {
  buildSubagentCompletionRecord,
  type SubagentCompletionRecord,
} from './subagentCompletionNotification';

export type BackgroundSubagentStatus = 'running' | 'completed' | 'failed';

export interface BackgroundSubagentHandle {
  agentId: string;
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
  private readonly consumedNotificationKeys = new Set<string>();
  private counter = 0;
  private readonly now: () => number;

  // now 注入便于测试；默认墙钟。本类非 DB 写路径，不受 repository Date.now 禁令约束。
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 后台跑 run，立即返回稳定 agentId，不阻塞调用方。 */
  spawn(run: () => Promise<SubagentResult>, options: BackgroundSubagentOptions = {}): string {
    const agentId = options.agentId ?? `subagent-bg-${++this.counter}`;
    const startedAt = this.now();
    const done = this.attachCompletion(agentId, run(), {
      ...options,
      agentId,
      startedAt,
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
    const done = this.attachCompletion(options.agentId, promise, {
      ...options,
      startedAt,
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
      ...(options.declaredOutputs && options.declaredOutputs.length > 0
        ? { declaredOutputs: options.declaredOutputs }
        : {}),
    });
    return options.agentId;
  }

  private attachCompletion(
    agentId: string,
    promise: Promise<SubagentResult>,
    options: BackgroundSubagentOptions & { startedAt: number },
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
        }
        return undefined;
      }
    })();
  }

  private recordCompletion(entry: BackgroundSubagentEntry, options: BackgroundSubagentOptions): void {
    const record = buildSubagentCompletionRecord({
      agentId: entry.agentId,
      role: entry.role,
      status: entry.status === 'completed' ? 'completed' : 'failed',
      output: entry.result?.output,
      error: entry.error,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      failureCode: entry.failureCode,
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

  drainCompletionNotifications(scope?: BackgroundSubagentScopeFilter): SubagentCompletionRecord[] {
    if (this.pendingNotifications.length === 0) return [];
    const matched: SubagentCompletionRecord[] = [];
    const remaining: SubagentCompletionRecord[] = [];

    for (const record of this.pendingNotifications) {
      if (!this.matchesScope(record, scope)) {
        remaining.push(record);
        continue;
      }
      if (this.consumedNotificationKeys.has(record.dedupeKey)) continue;
      this.consumedNotificationKeys.add(record.dedupeKey);
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
