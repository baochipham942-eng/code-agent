// ============================================================================
// Swarm Run Ledger 契约（ADR-022 §四第三期 3b · ADR-023 D2 双写过渡）
//
// append-only 协同事件账本 = Swarm 轨迹的「真理源」。可变 rollup 表
// (swarm_runs / swarm_run_agents) 降级为可从本账确定性重建的读优化缓存。
//
// 事件 kind：
//   - run_started   : 一次 swarm 运行开始（run 级起始字段）
//   - agent_snapshot: 某 agent 的 rollup 快照（同 agent 多条，回放时末值覆盖）
//   - run_closed    : 运行收尾（status/endedAt/aggregation 等）
// ============================================================================

import type { SwarmRunAgentRecord, SwarmRunCoordinator, SwarmRunStatus, SwarmRunTrigger } from './swarmTrace';
import type { SwarmAggregation } from './swarm';

export type SwarmLedgerEventKind = 'run_started' | 'agent_snapshot' | 'run_closed';

/** run_started 的 payload（run 级起始字段；sessionId 落在表列上）。 */
export interface SwarmRunStartedPayload {
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  totalAgents: number;
  trigger: SwarmRunTrigger;
}

/** agent_snapshot 的 payload = 某 agent 的完整 rollup 快照（不含 runId，落在表列/上下文）。 */
export type SwarmAgentSnapshotPayload = Omit<SwarmRunAgentRecord, 'runId'>;

/** run_closed 的 payload（运行收尾统计 + 聚合）。 */
export interface SwarmRunClosedPayload {
  status: SwarmRunStatus;
  endedAt: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  errorSummary: string | null;
  aggregation: SwarmAggregation | null;
  tags: string[];
}

/** 写入 ledger 的一条事件（append 入参）。recordedAt 走参数（禁裸 Date.now()）。 */
export interface SwarmLedgerAppendInput {
  runId: string;
  sessionId: string | null;
  seq: number;
  kind: SwarmLedgerEventKind;
  /** 仅 agent_snapshot 用 */
  agentId: string | null;
  payload: SwarmRunStartedPayload | SwarmAgentSnapshotPayload | SwarmRunClosedPayload;
  recordedAt: number;
}

/** 从 ledger 读回的一条事件。 */
export interface SwarmLedgerEvent {
  id: number;
  runId: string;
  sessionId: string | null;
  seq: number;
  kind: SwarmLedgerEventKind;
  agentId: string | null;
  payload: Record<string, unknown> | null;
  recordedAt: number;
}
