// ============================================================================
// SwarmTraceWriter — 把 EventBus 'swarm' 事件流持久化到 SQLite（ADR-010 #5）
// ============================================================================
//
// 订阅 EventBus 'swarm' domain，根据 swarm 事件维护一个 in-process 当前 run
// 状态，串行写入 SwarmTraceRepo。所有写入 fire-and-forget，不阻塞
// 事件发布者；run 收尾时由外部调用 drain() 等待最后一笔落盘。
//
// Writer 以 sessionId + runId 为隔离键维护 active run。所有 live 事件必须
// 显式携带完整 scope；缺字段或 tree 不匹配时 fail closed，不猜测当前 run。
// ============================================================================

import type { BusEvent } from '../protocol/events/busTypes';
import type {
  SwarmEvent,
  SwarmAgentState,
  SwarmAggregation,
} from '../../shared/contract/swarm';
import {
  createSwarmTraceStorageId,
  getSwarmRunScopeKey,
} from '../../shared/contract/swarm';
import type {
  SwarmRunCoordinator,
  SwarmRunTrigger,
  SwarmEventLevel,
  SwarmRunAgentRecord,
  SwarmTraceRepo,
} from '../../shared/contract/swarmTrace';
import type { SwarmLedgerAppendInput } from '../../shared/contract/swarmLedger';
import type { LibraryItem } from '../../shared/contract/library';
import { getEventBus } from '../services/eventing/bus';
import { createLogger } from '../services/infra/logger';
import { getLibraryService } from '../services/library/libraryService';

const logger = createLogger('SwarmTraceWriter');
/** append-only 账本中的每个任务/产出字段上限；超额正文改存资料库。 */
const SWARM_AGENT_TEXT_MAX_BYTES = 32 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

interface AgentRollup {
  name: string;
  role: string;
  status: SwarmRunAgentRecord['status'];
  startTime: number | null;
  endTime: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  filesChanged: string[];
  dispatchedTask?: string;
  dispatchedTaskTruncated?: boolean;
  dispatchedTaskArchiveItemId?: string;
  finalOutput?: string;
  finalOutputTruncated?: boolean;
  finalOutputArchiveItemId?: string;
}

interface RunState {
  runId: string;
  storageRunId: string;
  sessionId: string;
  treeId: string;
  key: string;
  startedAt: number;
  totalAgents: number;
  parallelPeak: number;
  agents: Map<string, AgentRollup>;
  seq: number;
  /** ledger 专用单调序号（run_started=0 < agent_snapshot... < run_closed），与 timeline seq 独立 */
  ledgerSeq: number;
  trigger: SwarmRunTrigger;
  coordinator: SwarmRunCoordinator;
}

export interface SwarmTraceWriterOptions {
  /** @deprecated Live SwarmEvent 必须显式携带 sessionId；仅保留构造兼容。 */
  getSessionId?: () => string | null;
  /** 默认 trigger，未来可由 ipc 入口在 launch 时改写（v1 默认 unknown） */
  defaultTrigger?: SwarmRunTrigger;
  /** 默认 coordinator 名（v1 标记为 hybrid） */
  defaultCoordinator?: SwarmRunCoordinator;
  /**
   * 3b 并行追加（ADR-023 D2）：在现有 rollup 写入**旁**，把 run_started/agent_snapshot/
   * run_closed 追加到 append-only 协同事件账本（真理源）。fail-safe，缺省不注入则 no-op，
   * 现有写入路径一行不改。
   */
  appendLedger?: (input: SwarmLedgerAppendInput) => void;
  /** 超限成员任务/产出的资料库归档；测试可注入失败或返回值。 */
  archiveText?: (args: {
    projectId: null;
    title: string;
    text: string;
    tags: string[];
    sourceSessionId: string;
    sourceRoleId: string;
  }) => LibraryItem;
}

export class SwarmTraceWriter {
  private readonly repo: SwarmTraceRepo;
  private readonly options: Required<Omit<SwarmTraceWriterOptions, 'appendLedger' | 'archiveText'>>;
  private readonly appendLedger?: (input: SwarmLedgerAppendInput) => void;
  private readonly archiveText: NonNullable<SwarmTraceWriterOptions['archiveText']>;
  private runs = new Map<string, RunState>();
  /** fire-and-forget 串行写入链，drain() 时 await 这条链 */
  private pendingPersist: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(repo: SwarmTraceRepo, options: SwarmTraceWriterOptions = {}) {
    this.repo = repo;
    this.options = {
      getSessionId: options.getSessionId ?? (() => null),
      defaultTrigger: options.defaultTrigger ?? 'unknown',
      defaultCoordinator: options.defaultCoordinator ?? 'hybrid',
    };
    this.appendLedger = options.appendLedger;
    this.archiveText = options.archiveText ?? ((args) => getLibraryService().archiveText(args));
  }

  /** 启动订阅，幂等 */
  install(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = getEventBus().subscribe<SwarmEvent>('swarm', (busEvt) => {
      this.handle(busEvt);
    });
    logger.debug('SwarmTraceWriter installed');
  }

  /** 取消订阅 + drain 当前未完成的写入（用于关停或测试 teardown） */
  async dispose(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.drain();
  }

  /** 等待所有挂起的串行写入落盘 */
  async drain(): Promise<void> {
    await this.pendingPersist;
  }

  // --------------------------------------------------------------------------
  // 主分发逻辑
  // --------------------------------------------------------------------------

  private handle(busEvt: BusEvent<SwarmEvent>): void {
    const event = busEvt.data;
    if (!event || typeof event !== 'object') return;
    if (!this.hasValidScope(event)) {
      logger.warn(`Ignoring ${event.type ?? 'swarm event'} without a complete run scope`);
      return;
    }
    if (busEvt.sessionId && busEvt.sessionId !== event.sessionId) {
      logger.warn(`Ignoring ${event.type}: EventBus/session scope mismatch`);
      return;
    }

    switch (event.type) {
      case 'swarm:started':
        this.onStarted(event);
        break;
      case 'swarm:agent:added':
      case 'swarm:agent:updated':
      case 'swarm:agent:completed':
      case 'swarm:agent:failed':
        this.onAgentEvent(event);
        break;
      case 'swarm:completed':
        this.appendTimelineEvent(event);
        this.onCompleted(event);
        return;
      case 'swarm:cancelled':
        this.appendTimelineEvent(event);
        this.onCancelled(event);
        return;
      default:
        // 其他事件（plan / message / launch）只写入 timeline，不动 agent 聚合
        break;
    }

    // 所有事件统一写入 timeline（含上面已处理的），便于回放
    this.appendTimelineEvent(event);
  }

  // --------------------------------------------------------------------------
  // 生命周期事件
  // --------------------------------------------------------------------------

  private onStarted(event: SwarmEvent): void {
    const runId = event.runId;
    const totalAgents = event.data.statistics?.total ?? 0;
    const sessionId = event.sessionId;
    const key = this.getRunKey(event);
    const existing = this.runs.get(key);
    if (existing) {
      logger.warn(`Ignoring duplicate swarm:started for ${sessionId}/${runId}`);
      return;
    }

    const state: RunState = {
      runId,
      storageRunId: createSwarmTraceStorageId(event),
      sessionId,
      treeId: event.treeId,
      key,
      startedAt: event.timestamp,
      totalAgents,
      parallelPeak: 0,
      agents: new Map(),
      seq: 0,
      ledgerSeq: 0,
      trigger: this.options.defaultTrigger,
      coordinator: this.options.defaultCoordinator,
    };
    this.runs.set(key, state);

    this.schedulePersist(() => {
      this.repo.startRun({
        id: state.storageRunId,
        sessionId,
        coordinator: this.options.defaultCoordinator,
        startedAt: event.timestamp,
        totalAgents,
        trigger: this.options.defaultTrigger,
      });
    });

    // 3b 并行追加：run_started 进协同事件账本（真理源），不影响上面的 rollup 写入
    this.appendLedgerEvent(state, 'run_started', null, {
      coordinator: state.coordinator,
      startedAt: state.startedAt,
      totalAgents: state.totalAgents,
      trigger: state.trigger,
    }, event.timestamp);
  }

  private onAgentEvent(event: SwarmEvent): void {
    const run = this.getRunForEvent(event);
    if (!run) return;
    const state = event.data.agentState;
    if (!state) return;

    const rollup = this.mergeAgentRollup(run, state);
    // parallel peak：取所有 status=running 的 agent 数量
    const runningCount = Array.from(run.agents.values()).filter(
      (a) => a.status === 'running',
    ).length;
    if (runningCount > run.parallelPeak) {
      run.parallelPeak = runningCount;
    }

    const runId = run.storageRunId;
    const durationMs =
      rollup.startTime != null && rollup.endTime != null
        ? rollup.endTime - rollup.startTime
        : null;
    const failureCategory = rollup.error ? this.classifyFailure(rollup.error) : null;
    this.schedulePersist(() => {
      this.repo.upsertAgent({
        runId,
        agentId: state.id,
        name: rollup.name,
        role: rollup.role,
        status: rollup.status,
        startTime: rollup.startTime,
        endTime: rollup.endTime,
        durationMs,
        tokensIn: rollup.tokensIn,
        tokensOut: rollup.tokensOut,
        toolCalls: rollup.toolCalls,
        costUsd: rollup.costUsd,
        error: rollup.error,
        failureCategory,
        filesChanged: rollup.filesChanged,
        dispatchedTask: rollup.dispatchedTask,
        dispatchedTaskTruncated: rollup.dispatchedTaskTruncated,
        dispatchedTaskArchiveItemId: rollup.dispatchedTaskArchiveItemId,
        finalOutput: rollup.finalOutput,
        finalOutputTruncated: rollup.finalOutputTruncated,
        finalOutputArchiveItemId: rollup.finalOutputArchiveItemId,
      });
    });

    // 3b 并行追加：agent_snapshot 进账本（同 agent 多条，回放时末值覆盖 = 当前 rollup 末值）
    this.appendLedgerEvent(run, 'agent_snapshot', state.id, {
      agentId: state.id,
      name: rollup.name,
      role: rollup.role,
      status: rollup.status,
      startTime: rollup.startTime,
      endTime: rollup.endTime,
      durationMs,
      tokensIn: rollup.tokensIn,
      tokensOut: rollup.tokensOut,
      toolCalls: rollup.toolCalls,
      costUsd: rollup.costUsd,
      error: rollup.error,
      failureCategory,
      filesChanged: rollup.filesChanged,
      dispatchedTask: rollup.dispatchedTask,
      dispatchedTaskTruncated: rollup.dispatchedTaskTruncated,
      dispatchedTaskArchiveItemId: rollup.dispatchedTaskArchiveItemId,
      finalOutput: rollup.finalOutput,
      finalOutputTruncated: rollup.finalOutputTruncated,
      finalOutputArchiveItemId: rollup.finalOutputArchiveItemId,
    }, event.timestamp);
  }

  private onCompleted(event: SwarmEvent): void {
    const run = this.getRunForEvent(event);
    if (!run) return;
    const stats = event.data.statistics;
    const aggregation: SwarmAggregation | null = event.data.result?.aggregation ?? null;
    const totals = this.aggregateAgentTotals(run);

    const closed = {
      id: run.storageRunId,
      status: (stats && stats.failed > 0 ? 'failed' : 'completed') as 'failed' | 'completed',
      endedAt: event.timestamp,
      completedCount: stats?.completed ?? 0,
      failedCount: stats?.failed ?? 0,
      parallelPeak: Math.max(run.parallelPeak, stats?.parallelPeak ?? 0),
      totalTokensIn: totals.tokensIn,
      totalTokensOut: totals.tokensOut,
      totalToolCalls: totals.toolCalls,
      totalCostUsd: totals.costUsd,
      errorSummary: totals.errorSummary,
      aggregation,
    };

    this.schedulePersist(() => this.repo.closeRun(closed));
    // 3b 并行追加：run_closed 进账本（携带收尾统计与聚合 = rollup 表所写）
    this.appendLedgerEvent(run, 'run_closed', null, {
      status: closed.status,
      endedAt: closed.endedAt,
      completedCount: closed.completedCount,
      failedCount: closed.failedCount,
      parallelPeak: closed.parallelPeak,
      totalTokensIn: closed.totalTokensIn,
      totalTokensOut: closed.totalTokensOut,
      totalToolCalls: closed.totalToolCalls,
      totalCostUsd: closed.totalCostUsd,
      errorSummary: closed.errorSummary,
      aggregation: closed.aggregation,
      tags: [],
    }, event.timestamp);
    this.runs.delete(run.key);
  }

  private onCancelled(event: SwarmEvent): void {
    const run = this.getRunForEvent(event);
    if (!run) return;
    const totals = this.aggregateAgentTotals(run);
    const closed = {
      id: run.storageRunId,
      status: 'cancelled' as const,
      endedAt: event.timestamp,
      completedCount: totals.completedCount,
      failedCount: totals.failedCount,
      parallelPeak: run.parallelPeak,
      totalTokensIn: totals.tokensIn,
      totalTokensOut: totals.tokensOut,
      totalToolCalls: totals.toolCalls,
      totalCostUsd: totals.costUsd,
      errorSummary: totals.errorSummary ?? 'cancelled',
      aggregation: null,
    };
    this.schedulePersist(() => this.repo.closeRun(closed));
    this.appendLedgerEvent(run, 'run_closed', null, {
      status: closed.status,
      endedAt: closed.endedAt,
      completedCount: closed.completedCount,
      failedCount: closed.failedCount,
      parallelPeak: closed.parallelPeak,
      totalTokensIn: closed.totalTokensIn,
      totalTokensOut: closed.totalTokensOut,
      totalToolCalls: closed.totalToolCalls,
      totalCostUsd: closed.totalCostUsd,
      errorSummary: closed.errorSummary,
      aggregation: closed.aggregation,
      tags: [],
    }, event.timestamp);
    this.runs.delete(run.key);
  }

  // --------------------------------------------------------------------------
  // Timeline & Helpers
  // --------------------------------------------------------------------------

  private appendTimelineEvent(event: SwarmEvent): void {
    const run = this.getRunForEvent(event);
    if (!run) return;
    const seq = run.seq++;
    const runId = run.storageRunId;

    const level: SwarmEventLevel =
      event.type === 'swarm:agent:failed' || event.type === 'swarm:cancelled'
        ? 'error'
        : event.type.includes('warn')
          ? 'warn'
          : 'info';

    const title = event.type.replace(/^swarm:/, '');
    const summary = this.summarizeEvent(event);

    this.schedulePersist(() => {
      this.repo.appendEvent({
        runId,
        seq,
        timestamp: event.timestamp,
        eventType: event.type,
        agentId: event.data.agentId ?? null,
        level,
        title,
        summary,
        payload: event.data,
      });
    });
  }

  private mergeAgentRollup(run: RunState, state: SwarmAgentState): AgentRollup {
    const existing = run.agents.get(state.id);
    const dispatchedTask = state.dispatchedTask === undefined
      ? undefined
      : this.compactAgentText('task', state.dispatchedTask, run, state.id, state.name || existing?.name || 'agent');
    const finalOutput = state.finalOutput === undefined
      ? undefined
      : this.compactAgentText('output', state.finalOutput, run, state.id, state.name || existing?.name || 'agent');
    const next: AgentRollup = {
      name: state.name || existing?.name || '',
      role: state.role || existing?.role || '',
      status: state.status,
      startTime: state.startTime ?? existing?.startTime ?? null,
      endTime: state.endTime ?? existing?.endTime ?? null,
      tokensIn: state.tokenUsage?.input ?? existing?.tokensIn ?? 0,
      tokensOut: state.tokenUsage?.output ?? existing?.tokensOut ?? 0,
      toolCalls: state.toolCalls ?? existing?.toolCalls ?? 0,
      costUsd: state.cost ?? existing?.costUsd ?? 0,
      error: state.error ?? existing?.error ?? null,
      filesChanged: state.filesChanged ?? existing?.filesChanged ?? [],
      dispatchedTask: dispatchedTask?.text ?? existing?.dispatchedTask,
      dispatchedTaskTruncated: dispatchedTask?.truncated ?? existing?.dispatchedTaskTruncated,
      dispatchedTaskArchiveItemId: dispatchedTask?.archiveItemId ?? existing?.dispatchedTaskArchiveItemId,
      finalOutput: finalOutput?.text ?? existing?.finalOutput,
      finalOutputTruncated: finalOutput?.truncated ?? existing?.finalOutputTruncated,
      finalOutputArchiveItemId: finalOutput?.archiveItemId ?? existing?.finalOutputArchiveItemId,
    };
    run.agents.set(state.id, next);
    return next;
  }

  private compactAgentText(
    kind: 'task' | 'output',
    text: string,
    run: RunState,
    agentId: string,
    agentName: string,
  ): { text: string; truncated?: boolean; archiveItemId?: string } {
    if (Buffer.byteLength(text, 'utf8') <= SWARM_AGENT_TEXT_MAX_BYTES) return { text };

    // 账本是不可删的轨迹真理源，不应承担无限文本存储；只保留可检索前缀，完整正文归档到资料库。
    const result: { text: string; truncated: true; archiveItemId?: string } = {
      text: truncateUtf8(text, SWARM_AGENT_TEXT_MAX_BYTES),
      truncated: true,
    };
    try {
      result.archiveItemId = this.archiveText({
        projectId: null,
        title: `Swarm ${agentName} ${kind === 'task' ? '下发任务' : '完整产出'}`,
        text,
        tags: ['swarm', kind],
        sourceSessionId: run.sessionId,
        sourceRoleId: agentId,
      }).id;
    } catch (error) {
      logger.warn('Swarm agent text archive failed; persisting truncated ledger snapshot', error);
    }
    return result;
  }

  private aggregateAgentTotals(run: RunState | undefined): {
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    costUsd: number;
    completedCount: number;
    failedCount: number;
    errorSummary: string | null;
  } {
    if (!run) {
      return { tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0, completedCount: 0, failedCount: 0, errorSummary: null };
    }
    let tokensIn = 0;
    let tokensOut = 0;
    let toolCalls = 0;
    let costUsd = 0;
    let completedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];
    for (const a of run.agents.values()) {
      tokensIn += a.tokensIn;
      tokensOut += a.tokensOut;
      toolCalls += a.toolCalls;
      costUsd += a.costUsd;
      if (a.status === 'completed') completedCount++;
      if (a.status === 'failed') {
        failedCount++;
        if (a.error) errors.push(`${a.name || 'agent'}: ${a.error}`);
      }
    }
    return {
      tokensIn,
      tokensOut,
      toolCalls,
      costUsd,
      completedCount,
      failedCount,
      errorSummary: errors.length > 0 ? errors.join('; ').slice(0, 1024) : null,
    };
  }

  private summarizeEvent(event: SwarmEvent): string {
    switch (event.type) {
      case 'swarm:started':
        return `started total=${event.data.statistics?.total ?? 0}`;
      case 'swarm:agent:added':
      case 'swarm:agent:updated':
      case 'swarm:agent:completed':
      case 'swarm:agent:failed':
        return `${event.data.agentState?.id ?? ''} → ${event.data.agentState?.status ?? ''}`;
      case 'swarm:completed':
        return `completed=${event.data.statistics?.completed ?? 0} failed=${event.data.statistics?.failed ?? 0}`;
      case 'swarm:cancelled':
        return 'cancelled';
      default:
        return event.type;
    }
  }

  /** 极简启发式失败归因，沿用 telemetry_tool_calls.error_category 的字符串风格 */
  private classifyFailure(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('timeout')) return 'timeout';
    if (m.includes('cancel')) return 'cancelled';
    if (m.includes('permission')) return 'permission';
    if (m.includes('rate limit') || m.includes('429')) return 'rate_limit';
    if (m.includes('network') || m.includes('econn')) return 'network';
    if (m.includes('parse')) return 'parse_error';
    return 'unknown';
  }

  private getRunForEvent(event: SwarmEvent): RunState | undefined {
    if (!this.hasValidScope(event)) return undefined;
    const run = this.runs.get(this.getRunKey(event));
    if (run?.treeId !== event.treeId) return undefined;
    return run;
  }

  private hasValidScope(event: SwarmEvent): boolean {
    return Boolean(
      typeof event.sessionId === 'string'
      && event.sessionId.trim()
      && typeof event.runId === 'string'
      && event.runId.trim()
      && typeof event.treeId === 'string'
      && event.treeId.trim(),
    );
  }

  private getRunKey(scope: Pick<SwarmEvent, 'sessionId' | 'runId' | 'treeId'>): string {
    return getSwarmRunScopeKey(scope);
  }

  /**
   * 3b 并行追加：把一条协同事件追加到 append-only 账本（真理源）。
   * 缺省未注入 appendLedger 则 no-op；全程 fail-safe，绝不影响现有 rollup 写入与 swarm 运行。
   * seq 走 run.ledgerSeq 单调递增（run_started=0 < agent_snapshot... < run_closed）。
   */
  private appendLedgerEvent(
    run: RunState,
    kind: SwarmLedgerAppendInput['kind'],
    agentId: string | null,
    payload: SwarmLedgerAppendInput['payload'],
    recordedAt: number,
  ): void {
    if (!this.appendLedger) return;
    const seq = run.ledgerSeq++;
    const input: SwarmLedgerAppendInput = {
      runId: run.storageRunId,
      sessionId: run.sessionId,
      seq,
      kind,
      agentId,
      payload,
      recordedAt,
    };
    this.schedulePersist(() => {
      this.appendLedger?.(input);
    });
  }

  private schedulePersist(fn: () => void): void {
    this.pendingPersist = this.pendingPersist.then(() => {
      try {
        fn();
      } catch (err) {
        logger.warn('SwarmTraceWriter persist failed', err);
      }
    });
  }
}

let writerInstance: SwarmTraceWriter | null = null;

export function getSwarmTraceWriter(): SwarmTraceWriter | null {
  return writerInstance;
}

export function installSwarmTraceWriter(
  repo: SwarmTraceRepo,
  options?: SwarmTraceWriterOptions,
): SwarmTraceWriter {
  if (writerInstance) return writerInstance;
  writerInstance = new SwarmTraceWriter(repo, options);
  writerInstance.install();
  return writerInstance;
}

/** 测试用：清空单例（外部调用方应先 dispose） */
export function resetSwarmTraceWriter(): void {
  writerInstance = null;
}
