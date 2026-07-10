// ============================================================================
// Swarm Types - 共享类型定义
// ============================================================================

import type { ContextHealthWarningLevel } from './contextHealth';

/**
 * Agent Team 的稳定运行身份。
 *
 * sessionId 绑定对话，runId 绑定一次 Team 执行，treeId 绑定 spawn 配额/父子树。
 * runId 在同一 session 内唯一；treeId 允许同一 Team 的嵌套 spawn 共享配额池。
 */
export interface SwarmRunRef {
  sessionId: string;
  runId: string;
}

export interface SwarmRunScope extends SwarmRunRef {
  treeId: string;
  /** Native Run that created this Team. Omitted only for legacy persisted scopes. */
  parentNativeRunId?: string;
}

export interface SwarmAgentRef extends SwarmRunRef {
  agentId: string;
}

const SCOPED_SWARM_AGENT_PREFIX = 'swarm-agent';
const SCOPED_SWARM_MESSAGE_PREFIX = 'swarm-message';
const SWARM_TRACE_STORAGE_PREFIX = 'swarm-trace';
const SCOPED_SWARM_AGENT_VERSION = 'v1';
const SCOPED_SWARM_SEPARATOR = '.';

function encodeScopePart(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeScopePart(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url-encoded swarm scope part');
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Stable key for Host run-scoped registries and checkpoints. */
export function getSwarmRunScopeKey(scope: SwarmRunScope): string {
  return [scope.sessionId, scope.runId, scope.treeId].map(encodeScopePart).join(SCOPED_SWARM_SEPARATOR);
}

/**
 * Stable spawn quota identity. Nested runs in one spawn tree intentionally
 * share capacity, while equal tree labels in different sessions do not.
 */
export function getSwarmTreeScopeKey(
  scope: Pick<SwarmRunScope, 'sessionId' | 'treeId'>,
): string {
  return [scope.sessionId, scope.treeId].map(encodeScopePart).join(SCOPED_SWARM_SEPARATOR);
}

/** Opaque persistence identity for trace/ledger repositories with a single id key. */
export function createSwarmTraceStorageId(scope: SwarmRunScope): string {
  return [
    SWARM_TRACE_STORAGE_PREFIX,
    SCOPED_SWARM_AGENT_VERSION,
    encodeScopePart(scope.sessionId),
    encodeScopePart(scope.runId),
    encodeScopePart(scope.treeId),
  ].join(SCOPED_SWARM_SEPARATOR);
}

export function parseSwarmTraceStorageId(storageId: string): SwarmRunScope | null {
  const parts = storageId.split(SCOPED_SWARM_SEPARATOR);
  if (parts.length !== 5) return null;
  try {
    const [prefix, version, encodedSessionId, encodedRunId, encodedTreeId] = parts;
    if (prefix !== SWARM_TRACE_STORAGE_PREFIX || version !== SCOPED_SWARM_AGENT_VERSION) {
      return null;
    }
    const sessionId = decodeScopePart(encodedSessionId);
    const runId = decodeScopePart(encodedRunId);
    const treeId = decodeScopePart(encodedTreeId);
    if (!sessionId || !runId || !treeId) return null;
    return { sessionId, runId, treeId };
  } catch {
    return null;
  }
}

/** Stable composite identity; the same local role/index can safely exist in concurrent Teams. */
export function createScopedSwarmAgentId(scope: SwarmRunScope, localAgentId: string): string {
  return [
    SCOPED_SWARM_AGENT_PREFIX,
    SCOPED_SWARM_AGENT_VERSION,
    encodeScopePart(scope.sessionId),
    encodeScopePart(scope.runId),
    encodeScopePart(scope.treeId),
    encodeScopePart(localAgentId),
  ].join(SCOPED_SWARM_SEPARATOR);
}

/** Stable conversation/ledger identity bound to the complete Team scope. */
export function createScopedSwarmMessageId(
  scope: SwarmRunScope,
  localMessageId: string,
): string {
  if (!localMessageId) throw new Error('Scoped swarm message id requires a local identity');
  return [
    SCOPED_SWARM_MESSAGE_PREFIX,
    SCOPED_SWARM_AGENT_VERSION,
    encodeScopePart(scope.sessionId),
    encodeScopePart(scope.runId),
    encodeScopePart(scope.treeId),
    encodeScopePart(localMessageId),
  ].join(SCOPED_SWARM_SEPARATOR);
}

export function parseScopedSwarmMessageId(
  messageId: string,
): { scope: SwarmRunScope; localMessageId: string } | null {
  const parts = messageId.split(SCOPED_SWARM_SEPARATOR);
  if (parts.length !== 6) return null;

  try {
    const [prefix, version, encodedSessionId, encodedRunId, encodedTreeId, encodedLocalMessageId] = parts;
    if (prefix !== SCOPED_SWARM_MESSAGE_PREFIX || version !== SCOPED_SWARM_AGENT_VERSION) {
      return null;
    }
    const sessionId = decodeScopePart(encodedSessionId);
    const runId = decodeScopePart(encodedRunId);
    const treeId = decodeScopePart(encodedTreeId);
    const localMessageId = decodeScopePart(encodedLocalMessageId);
    if (!sessionId || !runId || !treeId || !localMessageId) return null;
    return {
      scope: { sessionId, runId, treeId },
      localMessageId,
    };
  } catch {
    return null;
  }
}

export function parseScopedSwarmAgentId(
  agentId: string,
): { scope: SwarmRunScope; localAgentId: string } | null {
  const parts = agentId.split(SCOPED_SWARM_SEPARATOR);
  if (parts.length !== 6) return null;

  try {
    const [prefix, version, encodedSessionId, encodedRunId, encodedTreeId, encodedLocalAgentId] = parts;
    if (
      prefix !== SCOPED_SWARM_AGENT_PREFIX
      || version !== SCOPED_SWARM_AGENT_VERSION
    ) {
      return null;
    }
    const sessionId = decodeScopePart(encodedSessionId);
    const runId = decodeScopePart(encodedRunId);
    const treeId = decodeScopePart(encodedTreeId);
    const localAgentId = decodeScopePart(encodedLocalAgentId);
    if (!sessionId || !runId || !treeId || !localAgentId) return null;
    return {
      scope: { sessionId, runId, treeId },
      localAgentId,
    };
  } catch {
    return null;
  }
}

export function isSameSwarmRun(
  left: SwarmRunRef,
  right: SwarmRunRef,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId;
}

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
  sessionId: string;
  runId: string;
  treeId: string;
  parentNativeRunId?: string;
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
 * sessionId/runId/treeId/parentNativeRunId 由调用方显式提供。Emitter 不保存“当前 run”单槽，
 * 因此两个 Team 的重叠事件不会互相改写身份。
 */
export interface SwarmEvent {
  type: SwarmEventType;
  timestamp: number;
  runId: string;
  sessionId: string;
  treeId: string;
  /** Native Run parent; Team runId must never be written into ToolContext.runId. */
  parentNativeRunId?: string;
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
      id: string;
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
