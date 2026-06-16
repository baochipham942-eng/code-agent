// ============================================================================
// Swarm Trace Types — ADR-010 #5 持久化的运行/agent/事件三层契约
// ============================================================================
//
// 与 Langfuse 的 Trace / Observation / Event 三层模型对齐：
//   - SwarmRunRecord       ≈ trace（一次完整 swarm 执行）
//   - SwarmRunAgentRecord  ≈ observation（每个 agent 的 rollup 指标）
//   - SwarmRunEventRecord  ≈ event（timeline 单条事件）
//
// 字段命名：DB 用 snake_case，此处契约用 camelCase。Repository 负责映射。
// ============================================================================

import type { SwarmAggregation } from './swarm';

export type SwarmRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 写日志级别（对齐 Langfuse 的 DEBUG / INFO / WARN / ERROR） */
export type SwarmEventLevel = 'debug' | 'info' | 'warn' | 'error';

/** 触发来源：LLM 显式 spawn / UI 启动 / Auto agent runner */
export type SwarmRunTrigger = 'llm-spawn' | 'ui-launch' | 'auto' | 'unknown';

/** 哪个 coordinator 在驱动这次 run */
export type SwarmRunCoordinator = 'hybrid' | 'parallel' | 'auto' | 'unknown';

export interface SwarmRunRecord {
  id: string;
  sessionId: string | null;
  coordinator: SwarmRunCoordinator;
  status: SwarmRunStatus;
  startedAt: number;
  endedAt: number | null;
  totalAgents: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  trigger: SwarmRunTrigger;
  errorSummary: string | null;
  /** SwarmAggregation 快照，run 收尾时聚合写入 */
  aggregation: SwarmAggregation | null;
  /** 预留 tag 数组，v1 不强制使用 */
  tags: string[];
}

export interface SwarmRunAgentRecord {
  runId: string;
  agentId: string;
  name: string;
  role: string;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  /** 沿用 telemetry_tool_calls.error_category 的简单枚举式归因，不跑 LLM */
  failureCategory: string | null;
  filesChanged: string[];
}

export interface SwarmRunEventRecord {
  id: number;
  runId: string;
  seq: number;
  timestamp: number;
  eventType: string;
  agentId: string | null;
  level: SwarmEventLevel;
  title: string;
  summary: string;
  /** 精简后的 SwarmEvent.data（被 MAX_EVENT_PAYLOAD_BYTES 截断） */
  payload: unknown;
}

export interface SwarmRunDetail {
  run: SwarmRunRecord;
  agents: SwarmRunAgentRecord[];
  events: SwarmRunEventRecord[];
}

// ============================================================================
// Repository 入参（SQL / File 双实现共享）
// ============================================================================

export interface StartRunInput {
  id: string;
  sessionId: string | null;
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  totalAgents: number;
  trigger: SwarmRunTrigger;
}

export interface CloseRunInput {
  id: string;
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
  aggregation: SwarmRunRecord['aggregation'];
}

export interface UpsertAgentInput {
  runId: string;
  agentId: string;
  name: string;
  role: string;
  status: SwarmRunAgentRecord['status'];
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  failureCategory: string | null;
  filesChanged: string[];
}

export interface AppendEventInput {
  runId: string;
  seq: number;
  timestamp: number;
  eventType: string;
  agentId: string | null;
  level: SwarmEventLevel;
  title: string;
  summary: string;
  payload: unknown;
}

/**
 * Swarm Trace 持久化 repo 的统一契约。
 * SwarmTraceRepository (SQLite) 和 FileSwarmTraceRepository (JSONL) 都 implements 它,
 * 消费者 (SwarmTraceWriter / IPC handler / SwarmServices) 只依赖此 interface。
 */
export interface SwarmTraceRepo {
  startRun(input: StartRunInput): void;
  closeRun(input: CloseRunInput): void;
  upsertAgent(input: UpsertAgentInput): void;
  appendEvent(input: AppendEventInput): void;
  listRuns(limit: number): SwarmRunListItem[];
  getRunDetail(runId: string): SwarmRunDetail | null;
  /** 第四期 偏差自愈：用 ledger 确定性重建值覆盖 rollup 缓存（仅对账写闸门开时调用）。 */
  replaceRunCache(detail: SwarmRunDetail): void;
  deleteRun(runId: string): boolean;
  clearAll(): void;
}

export interface SwarmRunListItem {
  id: string;
  sessionId: string | null;
  status: SwarmRunStatus;
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  totalAgents: number;
  completedCount: number;
  failedCount: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  trigger: SwarmRunTrigger;
}
