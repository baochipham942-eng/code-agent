// ============================================================================
// SpawnGuard 数据模型 — 类型、纯 helper 与工具禁用表
// 从 spawnGuard.ts 逐字搬出（god file 减肥，N-MAXLINES-MINEFIELD-2-FU1-S2）；
// SpawnGuard 类本体与 singleton 仍在 ./spawnGuard。
// ============================================================================

import { join } from 'path';
import { createHash } from 'crypto';
import { SPAWN_GUARD } from '../../shared/constants/agent';
import { READONLY_TOOL_DENYLIST } from './routingToolPolicy';
import type { SubagentResult } from './subagentExecutorTypes';
import {
  getSwarmRunScopeKey,
  getSwarmTreeScopeKey,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import type { SubagentCompletionKind } from './subagentCompletionNotification';
import type { AgentMessage } from './messageOrigin';

// ============================================================================
// Types
// ============================================================================

export interface ManagedAgent {
  id: string;
  completion?: { title?: string; kind?: SubagentCompletionKind };
  role: string;
  treeId: string;
  sessionId?: string;
  runId?: string;
  scope?: SwarmRunScope;
  parentId?: string;
  status: ManagedAgentStatus;
  task: string;
  /** The promise that resolves when execution completes */
  promise: Promise<SubagentResult>;
  /** AbortController to cancel execution */
  abortController: AbortController;
  /** Result after completion */
  result?: SubagentResult;
  /** Error message if failed */
  error?: string;
  /** Recovery semantics after restoring persisted subagent state */
  recoveryPlan?: ManagedAgentRecoveryPlan;
  /** Structured message queue (consumed by executor each iteration) */
  messageQueue: AgentMessage[];
  createdAt: number;
  completedAt?: number;
  slotReleased?: boolean;
}

export type ManagedAgentStatus =
  | 'running'
  | 'running-recovered'
  | 'dead-log-only'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed';

type ManagedAgentRecoveryStatus =
  | 'interrupted-by-restart'
  | 'completed-before-restart'
  | 'failed-before-restart'
  | 'cancelled-before-restart'
  | 'dead-log-only';

interface ManagedAgentRecoveryPlan {
  status: ManagedAgentRecoveryStatus;
  recoverable: boolean;
  summary: string;
  recommendedActions: string[];
}

export interface SpawnGuardConfig {
  /** Maximum concurrent agents across the whole spawn tree (default 8) */
  maxAgents?: number;
  /** Maximum nesting depth (default 3; clamped to hard max 5) */
  maxDepth?: number;
}

export interface RegisterOptions {
  treeId?: string;
  parentId?: string;
  slotAcquired?: boolean;
  scope?: SwarmRunScope;
  completion?: { title?: string; kind?: SubagentCompletionKind };
}

export interface SpawnGuardScopeFilter {
  sessionId: string;
  runId?: string;
  treeId?: string;
}

export interface PendingAgentNotification {
  sessionId?: string;
  runId?: string;
  treeId: string;
  content: string;
}

/** Serializable snapshot of SpawnGuard state for crash recovery */
export interface PersistedSpawnGuardState {
  scope?: SwarmRunScope;
  agents: Array<{
    id: string;
    completion?: { title?: string; kind?: SubagentCompletionKind };
    role: string;
    treeId?: string;
    sessionId?: string;
    runId?: string;
    parentId?: string;
    status: ManagedAgentStatus;
    task: string;
    messageQueue: AgentMessage[];
    createdAt: number;
    completedAt?: number;
    result?: SubagentResult;
    error?: string;
    recoveryPlan?: ManagedAgentRecoveryPlan;
  }>;
  pendingNotifications: Array<string | PendingAgentNotification>;
  persistedAt: number;
}

export interface SpawnSlotLease {
  treeId: string;
  scope?: SwarmRunScope;
  release: () => void;
}

export interface SlotWaiter {
  treeId: string;
  scope?: SwarmRunScope;
  signal?: AbortSignal;
  resolve: (lease: SpawnSlotLease) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_AGENTS = SPAWN_GUARD.MAX_TREE_AGENTS;
const DEFAULT_MAX_DEPTH = SPAWN_GUARD.DEFAULT_SPAWN_DEPTH;
const HARD_MAX_DEPTH = SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH;
const DEFAULT_QUEUE_TIMEOUT_MS = SPAWN_GUARD.QUEUE_WAIT_TIMEOUT_MS;
const DEFAULT_TREE_ID = 'default';
const LEGACY_SLOT_PREFIX = 'legacy:';
const LEGACY_STATE_FILE = 'spawn-guard-state.json';

// ============================================================================
// Pure helpers
// ============================================================================

function cloneRunScope(scope: SwarmRunScope): SwarmRunScope {
  return {
    sessionId: scope.sessionId,
    runId: scope.runId,
    treeId: scope.treeId,
    parentNativeRunId: scope.parentNativeRunId,
  };
}

function isSameRunScope(left: SwarmRunScope, right: SwarmRunScope): boolean {
  return getSwarmRunScopeKey(left) === getSwarmRunScopeKey(right);
}

function getCancellationReason(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return fallback;
}

function createSlotCancellationError(treeId: string, reason: unknown): Error {
  return new Error(
    `Spawn slot wait cancelled for tree ${treeId}: ${getCancellationReason(reason, 'cancelled')}`,
  );
}

function getScopedStateFileName(scope: SwarmRunScope): string {
  const digest = createHash('sha256')
    .update(getSwarmRunScopeKey(scope))
    .digest('hex')
    .slice(0, 32);
  return `spawn-guard-run-${digest}.json`;
}

function getSpawnGuardStatePath(sessionDir: string, scope?: SwarmRunScope): string {
  return join(sessionDir, scope ? getScopedStateFileName(scope) : LEGACY_STATE_FILE);
}

export type OnAgentCompleteCallback = (agent: ManagedAgent) => void;

export function isLiveRunningStatus(status: ManagedAgentStatus | string | undefined): boolean {
  return status === 'running' || status === 'running-recovered';
}

function buildManagedAgentRecoveryPlan(
  status: ManagedAgentStatus,
  wasRunning: boolean,
): ManagedAgentRecoveryPlan | undefined {
  if (wasRunning) {
    return {
      status: 'interrupted-by-restart',
      recoverable: false,
      summary: 'Subagent live execution was interrupted by app restart; previous messages remain, but the process is not live.',
      recommendedActions: ['review_messages', 'restart_subagent_if_needed'],
    };
  }
  if (status === 'completed') {
    return {
      status: 'completed-before-restart',
      recoverable: true,
      summary: 'Subagent completed before restart; stored result can be reviewed.',
      recommendedActions: ['review_result'],
    };
  }
  if (status === 'failed') {
    return {
      status: 'failed-before-restart',
      recoverable: false,
      summary: 'Subagent failed before restart; review the stored error before retrying.',
      recommendedActions: ['review_error', 'retry_if_needed'],
    };
  }
  if (status === 'cancelled' || status === 'killed') {
    return {
      status: 'cancelled-before-restart',
      recoverable: false,
      summary: 'Subagent stopped before restart; retry only if the task is still needed.',
      recommendedActions: ['retry_if_needed'],
    };
  }
  if (status === 'dead-log-only') {
    return {
      status: 'dead-log-only',
      recoverable: false,
      summary: 'Subagent has no live process; only persisted messages or logs can be reviewed.',
      recommendedActions: ['review_messages', 'restart_subagent_if_needed'],
    };
  }
  return undefined;
}

// ============================================================================
// Disabled tool tables
// ============================================================================

/**
 * Tools disabled for all subagents.
 *
 * Nested spawning is intentionally allowed through spawn_agent / AgentSpawn / Task.
 * User-interactive, workflow orchestration, and agent-control tools stay disabled:
 * subagents should return distilled results to their parent, not ask the user,
 * manage siblings, drive teams, or mutate the parent orchestration state.
 */
const SUBAGENT_DISABLED_TOOLS = [
  'agent_message',      // 子代理不能操控其他 agent
  'AgentMessage',
  'wait_agent',         // Phase 2 新增工具也禁用
  'WaitAgent',
  'close_agent',
  'CloseAgent',
  'send_input',         // Phase 3
  'SendInput',
  'ask_user_question',  // 子代理不能问用户
  'AskUserQuestion',
  'workflow',
  'DynamicWorkflow',
  'workflow_orchestrate',
  'WorkflowOrchestrate',
  'teammate',
  'Teammate',
  'plan_review',        // 跨 agent 审批（子代理不应自审）
  'PlanReview',
];

/**
 * Additional tools disabled for read-only roles (explorer, reviewer)
 * Enforces immutability at tool level, not just prompt level.
 * 单一来源：routingToolPolicy.READONLY_TOOL_DENYLIST（主对话 /agent 显式路由共用）。
 */
const READONLY_DISABLED_TOOLS = [...READONLY_TOOL_DENYLIST];

export {
  DEFAULT_MAX_AGENTS,
  DEFAULT_MAX_DEPTH,
  HARD_MAX_DEPTH,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_TREE_ID,
  LEGACY_SLOT_PREFIX,
  cloneRunScope,
  isSameRunScope,
  createSlotCancellationError,
  getSpawnGuardStatePath,
  buildManagedAgentRecoveryPlan,
  SUBAGENT_DISABLED_TOOLS,
  READONLY_DISABLED_TOOLS,
};
