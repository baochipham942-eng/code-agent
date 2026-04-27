// ============================================================================
// SwarmTraceWriter — 把 EventBus 'swarm' 事件流持久化到 SQLite（ADR-010 #5）
// ============================================================================
//
// 订阅 EventBus 'swarm' domain，根据 swarm 事件维护一个 in-process 当前 run
// 状态，串行写入 SwarmTraceRepository。所有写入 fire-and-forget，不阻塞
// 事件发布者；run 收尾时由外部调用 drain() 等待最后一笔落盘。
//
// 单进程同一时刻只允许一个 active run（与 SwarmEventEmitter 的 currentRunId
// 假设一致）。重叠场景下旧 run 会被新 run 直接覆盖。
// ============================================================================

import type { BusEvent } from '../protocol/events/busTypes';
import type {
  SwarmEvent,
  SwarmAgentState,
  SwarmAggregation,
} from '../../shared/contract/swarm';
import type {
  SwarmRunCoordinator,
  SwarmRunTrigger,
  SwarmEventLevel,
  SwarmRunAgentRecord,
} from '../../shared/contract/swarmTrace';
import type { SwarmTraceRepository } from '../services/core/repositories/SwarmTraceRepository';
import { getEventBus } from '../protocol/events/bus';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SwarmTraceWriter');

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
}

interface RunState {
  runId: string;
  startedAt: number;
  totalAgents: number;
  parallelPeak: number;
  agents: Map<string, AgentRollup>;
  seq: number;
  trigger: SwarmRunTrigger;
  coordinator: SwarmRunCoordinator;
}

export interface SwarmTraceWriterOptions {
  /** 当前 sessionId 解析器（每次 startedRun 时调用一次取值并缓存到 run） */
  getSessionId?: () => string | null;
  /** 默认 trigger，未来可由 ipc 入口在 launch 时改写（v1 默认 unknown） */
  defaultTrigger?: SwarmRunTrigger;
  /** 默认 coordinator 名（v1 标记为 hybrid） */
  defaultCoordinator?: SwarmRunCoordinator;
}

export class SwarmTraceWriter {
  private readonly repo: SwarmTraceRepository;
  private readonly options: Required<SwarmTraceWriterOptions>;
  private current: RunState | null = null;
  /** fire-and-forget 串行写入链，drain() 时 await 这条链 */
  private pendingPersist: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(repo: SwarmTraceRepository, options: SwarmTraceWriterOptions = {}) {
    this.repo = repo;
    this.options = {
      getSessionId: options.getSessionId ?? (() => null),
      defaultTrigger: options.defaultTrigger ?? 'unknown',
      defaultCoordinator: options.defaultCoordinator ?? 'hybrid',
    };
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
    if (!runId) {
      logger.warn('swarm:started without runId, skip persistence');
      return;
    }

    const totalAgents = event.data.statistics?.total ?? 0;
    const sessionId = event.sessionId ?? this.options.getSessionId();

    this.current = {
      runId,
      startedAt: event.timestamp,
      totalAgents,
      parallelPeak: 0,
      agents: new Map(),
      seq: 0,
      trigger: this.options.defaultTrigger,
      coordinator: this.options.defaultCoordinator,
    };

    this.schedulePersist(() => {
      this.repo.startRun({
        id: runId,
        sessionId,
        coordinator: this.options.defaultCoordinator,
        startedAt: event.timestamp,
        totalAgents,
        trigger: this.options.defaultTrigger,
      });
    });
  }

  private onAgentEvent(event: SwarmEvent): void {
    if (!this.current || !event.runId || event.runId !== this.current.runId) return;
    const state = event.data.agentState;
    if (!state) return;

    const rollup = this.mergeAgentRollup(state);
    // parallel peak：取所有 status=running 的 agent 数量
    const runningCount = Array.from(this.current.agents.values()).filter(
      (a) => a.status === 'running',
    ).length;
    if (runningCount > this.current.parallelPeak) {
      this.current.parallelPeak = runningCount;
    }

    const runId = this.current.runId;
    this.schedulePersist(() => {
      this.repo.upsertAgent({
        runId,
        agentId: state.id,
        name: rollup.name,
        role: rollup.role,
        status: rollup.status,
        startTime: rollup.startTime,
        endTime: rollup.endTime,
        durationMs:
          rollup.startTime != null && rollup.endTime != null
            ? rollup.endTime - rollup.startTime
            : null,
        tokensIn: rollup.tokensIn,
        tokensOut: rollup.tokensOut,
        toolCalls: rollup.toolCalls,
        costUsd: rollup.costUsd,
        error: rollup.error,
        failureCategory: rollup.error ? this.classifyFailure(rollup.error) : null,
        filesChanged: rollup.filesChanged,
      });
    });
  }

  private onCompleted(event: SwarmEvent): void {
    if (!this.current || !event.runId || event.runId !== this.current.runId) return;
    const stats = event.data.statistics;
    const aggregation: SwarmAggregation | null = event.data.result?.aggregation ?? null;
    const totals = this.aggregateAgentTotals();

    const closed = {
      id: this.current.runId,
      status: (stats && stats.failed > 0 ? 'failed' : 'completed') as 'failed' | 'completed',
      endedAt: event.timestamp,
      completedCount: stats?.completed ?? 0,
      failedCount: stats?.failed ?? 0,
      parallelPeak: Math.max(this.current.parallelPeak, stats?.parallelPeak ?? 0),
      totalTokensIn: totals.tokensIn,
      totalTokensOut: totals.tokensOut,
      totalToolCalls: totals.toolCalls,
      totalCostUsd: totals.costUsd,
      errorSummary: totals.errorSummary,
      aggregation,
    };

    this.schedulePersist(() => this.repo.closeRun(closed));
    this.current = null;
  }

  private onCancelled(event: SwarmEvent): void {
    if (!this.current || !event.runId || event.runId !== this.current.runId) return;
    const totals = this.aggregateAgentTotals();
    const closed = {
      id: this.current.runId,
      status: 'cancelled' as const,
      endedAt: event.timestamp,
      completedCount: totals.completedCount,
      failedCount: totals.failedCount,
      parallelPeak: this.current.parallelPeak,
      totalTokensIn: totals.tokensIn,
      totalTokensOut: totals.tokensOut,
      totalToolCalls: totals.toolCalls,
      totalCostUsd: totals.costUsd,
      errorSummary: totals.errorSummary ?? 'cancelled',
      aggregation: null,
    };
    this.schedulePersist(() => this.repo.closeRun(closed));
    this.current = null;
  }

  // --------------------------------------------------------------------------
  // Timeline & Helpers
  // --------------------------------------------------------------------------

  private appendTimelineEvent(event: SwarmEvent): void {
    if (!this.current || !event.runId || event.runId !== this.current.runId) return;
    const seq = this.current.seq++;
    const runId = this.current.runId;

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

  private mergeAgentRollup(state: SwarmAgentState): AgentRollup {
    if (!this.current) {
      throw new Error('mergeAgentRollup called without active run');
    }
    const existing = this.current.agents.get(state.id);
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
    };
    this.current.agents.set(state.id, next);
    return next;
  }

  private aggregateAgentTotals(): {
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    costUsd: number;
    completedCount: number;
    failedCount: number;
    errorSummary: string | null;
  } {
    if (!this.current) {
      return { tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0, completedCount: 0, failedCount: 0, errorSummary: null };
    }
    let tokensIn = 0;
    let tokensOut = 0;
    let toolCalls = 0;
    let costUsd = 0;
    let completedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];
    for (const a of this.current.agents.values()) {
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
  repo: SwarmTraceRepository,
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
