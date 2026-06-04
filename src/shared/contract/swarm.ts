// ============================================================================
// Swarm Types - 共享类型定义
// ============================================================================

import type { ContextHealthWarningLevel } from './contextHealth';

/**
 * Agent 执行状态（复制自 agentSwarm.ts 避免循环依赖）
 */
export type AgentStatus =
  | 'pending'     // 等待依赖
  | 'ready'       // 可执行
  | 'running'     // 执行中
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'cancelled';  // 已取消

export interface SwarmAgentContextPreview {
  role: string;
  contentPreview: string;
  tokens: number;
}

export interface SwarmAgentContextSnapshot {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  messageCount: number;
  warningLevel: ContextHealthWarningLevel;
  lastUpdated: number;
  tools: string[];
  attachments: string[];
  previews: SwarmAgentContextPreview[];
  truncatedMessages: number;
}

/**
 * Agent 实时状态（用于 UI 展示）
 */
export interface SwarmAgentState {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  iterations: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
  toolCalls?: number;
  lastReport?: string;
  error?: string;
  /** Cost incurred by this agent (USD) */
  cost?: number;
  /** Result preview text (first ~200 chars) */
  resultPreview?: string;
  /** Files this agent changed */
  filesChanged?: string[];
  /** Lightweight per-agent context snapshot */
  contextSnapshot?: SwarmAgentContextSnapshot;
}

/**
 * Swarm 执行状态（用于 UI 展示）
 */
export interface SwarmExecutionState {
  isRunning: boolean;
  startTime?: number;
  agents: SwarmAgentState[];
  statistics: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    parallelPeak: number;
    totalTokens: number;
    totalToolCalls: number;
  };
  /** Result aggregation (populated after swarm:completed) */
  aggregation?: SwarmAggregation;
}

/**
 * Aggregated team result for UI display
 */
export interface SwarmAggregation {
  summary: string;
  filesChanged: string[];
  totalCost: number;
  totalDuration: number;
  speedup: number;
  successRate: number;
  totalIterations: number;
}

export interface SwarmLaunchTaskPreview {
  id: string;
  role: string;
  task: string;
  dependsOn?: string[];
  tools: string[];
  writeAccess: boolean;
}

export interface SwarmLaunchRequest {
  id: string;
  sessionId?: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  resolvedAt?: number;
  summary: string;
  agentCount: number;
  dependencyCount: number;
  writeAgentCount: number;
  feedback?: string;
  tasks: SwarmLaunchTaskPreview[];
}

/**
 * Swarm 事件类型
 */
export type SwarmEventType =
  | 'swarm:launch:requested'
  | 'swarm:launch:approved'
  | 'swarm:launch:rejected'
  | 'swarm:started'
  | 'swarm:agent:added'
  | 'swarm:agent:updated'
  | 'swarm:agent:completed'
  | 'swarm:agent:failed'
  | 'swarm:completed'
  | 'swarm:cancelled'
  // Agent Teams P2P 通信事件
  | 'swarm:agent:message'         // agent 间消息
  | 'swarm:agent:plan_review'     // plan 审批请求
  | 'swarm:agent:plan_approved'   // plan 通过
  | 'swarm:agent:plan_rejected'   // plan 驳回
  | 'swarm:user:message'          // 用户直接消息
  | 'swarm:context:update';       // SharedContext 协作过程（发现/决策/人话状态）→ 讨论流

/**
 * SharedContext 协作过程的一条变更，用于 SwarmMonitor「讨论流」渲染（P1-3）。
 * - `finding`：子代理产出的发现（coordinator `discovery` 事件桥接而来）
 * - `decision`：关键方案选择 / agent 分歧（子代理自报，渲染时高亮）
 * - `status`：子代理自报的一句人话状态（"Planning completed. No product code modified."）
 * - `result`：result passing（一个 agent 的产出被传递给下游）
 * `at` 取自 SharedContext.lastUpdated（#213 版本戳），用于展示「X 分钟前更新」。
 */
export type SwarmContextUpdateKind = 'finding' | 'decision' | 'status' | 'result';

export interface SwarmContextUpdate {
  kind: SwarmContextUpdateKind;
  /** 产出该条目的子代理 id（对应 SwarmAgentState.id），可空（系统级条目） */
  agentId?: string;
  /** 子代理角色名，便于无 agentState 时也能显示「研究员」而非时间戳 id */
  role?: string;
  /** 人话内容 */
  content: string;
  /** SharedContext 中的 key（finding/decision 的键），用于去重展示 */
  key?: string;
  /** 最后更新时间戳（ms epoch），取自 SharedContext.lastUpdated */
  at: number;
}

/**
 * 验证检查结果（用于 Swarm 验证步骤）
 */
export interface VerificationCheckResult {
  name: string;
  passed: boolean;
  score: number;
  message: string;
}

/**
 * Swarm 验证结果（用于 UI 展示）
 */
export interface SwarmVerificationResult {
  passed: boolean;
  score: number;
  checks: VerificationCheckResult[];
  suggestions?: string[];
  taskType: string;
  durationMs: number;
}

/**
 * Swarm 事件载荷
 *
 * runId 用于关联同一次 swarm 执行内的所有事件。由 SwarmEventEmitter 在
 * `started` 时生成、其余事件统一打戳、`completed`/`cancelled` 时清空。
 * 对齐 OpenTelemetry / W3C Trace Context 把 trace id 写进消息契约的实践
 * （ADR-010 #5）。Renderer 端可不依赖此字段，仅 SwarmTraceWriter 需要。
 */
export interface SwarmEvent {
  type: SwarmEventType;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  data: {
    agentId?: string;
    agentState?: SwarmAgentState;
    statistics?: SwarmExecutionState['statistics'];
    result?: {
      success: boolean;
      totalTime: number;
      aggregatedOutput?: string;
      verification?: SwarmVerificationResult;
      aggregation?: SwarmAggregation;
    };
    // Agent Teams 扩展数据
    message?: {
      from: string;
      to: string;
      content: string;
      messageType?: string;
    };
    launchRequest?: SwarmLaunchRequest;
    plan?: {
      id?: string;
      agentId: string;
      content: string;
      status?: 'pending' | 'approved' | 'rejected';
      feedback?: string;
    };
    /** SharedContext 协作过程变更（P1-3 讨论流） */
    contextUpdate?: SwarmContextUpdate;
  };
}
