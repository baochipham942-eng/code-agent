// ============================================================================
// SpawnGuard - 子代理并发守卫 + 生命周期管理
// ============================================================================
//
// 借鉴 Codex CLI 的 guards.rs：
// - 并发限制（MAX_TREE_AGENTS / DEFAULT_SPAWN_DEPTH / HARD_MAX_SPAWN_DEPTH）
// - 持有 executor promise + AbortController 引用
// - RAII 风格 reserve/release
// ============================================================================

import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';
import { SPAWN_GUARD } from '../../shared/constants/agent';
import { READONLY_TOOL_DENYLIST } from './routingToolPolicy';
import type { SubagentResult } from './subagentExecutorTypes';
import {
  collectDescendantAgentIds,
  collectRunningOrphanAgentIds,
} from './orphanLiveness';
import {
  getSwarmRunScopeKey,
  getSwarmTreeScopeKey,
  parseScopedSwarmAgentId,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';

const logger = createLogger('SpawnGuard');

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// 结构化 Agent 消息协议
// ============================================================================

export type AgentMessageType =
  | 'text'                    // 普通文本（向后兼容）
  | 'shutdown_request'        // 父请求子关闭
  | 'shutdown_response'       // 子同意/拒绝关闭
  | 'plan_approval_request'   // 子提交计划待审
  | 'plan_approval_response'  // 父审批结果
  | 'status_update';          // 进度汇报

export interface AgentMessage {
  type: AgentMessageType;
  from: string;
  payload: string;
  timestamp: number;
}

/** Create a text message (backward compatible shorthand) */
export function createTextMessage(from: string, text: string): AgentMessage {
  return { type: 'text', from, payload: text, timestamp: Date.now() };
}

/** Create a structured message */
export function createAgentMessage(
  type: AgentMessageType,
  from: string,
  payload: Record<string, unknown>
): AgentMessage {
  return { type, from, payload: JSON.stringify(payload), timestamp: Date.now() };
}

export interface ManagedAgent {
  id: string;
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

export type ManagedAgentRecoveryStatus =
  | 'interrupted-by-restart'
  | 'completed-before-restart'
  | 'failed-before-restart'
  | 'cancelled-before-restart'
  | 'dead-log-only';

export interface ManagedAgentRecoveryPlan {
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

interface RegisterOptions {
  treeId?: string;
  parentId?: string;
  slotAcquired?: boolean;
  scope?: SwarmRunScope;
}

export interface SpawnGuardScopeFilter {
  sessionId: string;
  runId?: string;
  treeId?: string;
}

interface PendingAgentNotification {
  sessionId?: string;
  runId?: string;
  treeId: string;
  content: string;
}

/** Serializable snapshot of SpawnGuard state for crash recovery */
interface PersistedSpawnGuardState {
  scope?: SwarmRunScope;
  agents: Array<{
    id: string;
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

interface SlotWaiter {
  treeId: string;
  scope?: SwarmRunScope;
  signal?: AbortSignal;
  resolve: (lease: SpawnSlotLease) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

// ============================================================================
// SpawnGuard
// ============================================================================

const DEFAULT_MAX_AGENTS = SPAWN_GUARD.MAX_TREE_AGENTS;
const DEFAULT_MAX_DEPTH = SPAWN_GUARD.DEFAULT_SPAWN_DEPTH;
const HARD_MAX_DEPTH = SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH;
const DEFAULT_QUEUE_TIMEOUT_MS = SPAWN_GUARD.QUEUE_WAIT_TIMEOUT_MS;
const DEFAULT_TREE_ID = 'default';
const LEGACY_SLOT_PREFIX = 'legacy:';
const LEGACY_STATE_FILE = 'spawn-guard-state.json';

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

function isLiveRunningStatus(status: ManagedAgentStatus): boolean {
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

class SpawnGuard {
  private agents: Map<string, ManagedAgent> = new Map();
  private treeSlotCounts: Map<string, number> = new Map();
  private slotQueues: Map<string, SlotWaiter[]> = new Map();
  private maxAgents: number;
  private maxDepth: number;
  private onCompleteCallbacks: OnAgentCompleteCallback[] = [];
  /** Pending completion notifications for parent agent to drain each turn */
  private pendingNotifications: PendingAgentNotification[] = [];

  constructor(config: SpawnGuardConfig = {}) {
    this.maxAgents = config.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.maxDepth = this.clampDepth(config.maxDepth ?? DEFAULT_MAX_DEPTH);
  }

  /**
   * Try to reserve a slot for a new agent.
   * Returns false if at capacity.
   */
  canSpawn(identity: string | SwarmRunScope = DEFAULT_TREE_ID): boolean {
    return this.getReservedCount(identity) < this.maxAgents;
  }

  /**
   * Acquire a slot in the root tree pool. Over-capacity callers wait FIFO.
   */
  async acquireSlot(options: {
    treeId?: string;
    scope?: SwarmRunScope;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<SpawnSlotLease> {
    const slot = this.resolveSlotIdentity(options.scope ?? options.treeId);
    if (options.scope && options.treeId && this.normalizeTreeId(options.treeId) !== options.scope.treeId) {
      throw new Error('Spawn slot treeId does not match run scope.');
    }
    if (options.signal?.aborted) {
      throw createSlotCancellationError(slot.treeId, options.signal.reason);
    }
    if (this.getReservedCountByKey(slot.key) < this.maxAgents) {
      this.incrementSlot(slot.key);
      return this.createLease(slot.treeId, slot.key, slot.scope);
    }

    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS));
    return new Promise<SpawnSlotLease>((resolve, reject) => {
      const waiter: SlotWaiter = {
        treeId: slot.treeId,
        scope: slot.scope,
        signal: options.signal,
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        if (!this.removeWaiter(slot.key, waiter)) return;
        this.cleanupWaiter(waiter);
        reject(new Error(`Spawn slot wait timed out for tree ${slot.treeId} after ${timeoutMs}ms (running ${this.getReservedCountByKey(slot.key)}, max ${this.maxAgents})`));
      }, timeoutMs);
      const queue = this.getQueue(slot.key);
      queue.push(waiter);
      if (options.signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(slot.key, waiter)) return;
          this.cleanupWaiter(waiter);
          reject(createSlotCancellationError(slot.treeId, options.signal?.reason));
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
        if (options.signal.aborted) {
          waiter.onAbort();
          return;
        }
      }
      logger.info(`[${slot.treeId}] Spawn queued (${this.getReservedCountByKey(slot.key)}/${this.maxAgents}, queue: ${queue.length})`);
    });
  }

  getReservedCount(identity: string | SwarmRunScope = DEFAULT_TREE_ID): number {
    return this.getReservedCountByKey(this.resolveSlotIdentity(identity).key);
  }

  /**
   * Check if spawning is allowed at the given depth.
   */
  checkDepth(depth: number, overrideMaxDepth?: number): boolean {
    return depth <= this.getMaxDepth(overrideMaxDepth);
  }

  /**
   * Get configured nesting depth, optionally applying a session override.
   */
  getMaxDepth(overrideMaxDepth?: number): number {
    return this.clampDepth(overrideMaxDepth ?? this.maxDepth);
  }

  private clampDepth(depth: number): number {
    if (!Number.isFinite(depth)) return DEFAULT_MAX_DEPTH;
    return Math.min(Math.max(1, Math.floor(depth)), HARD_MAX_DEPTH);
  }

  private normalizeTreeId(treeId: string | undefined): string {
    return treeId?.trim() || DEFAULT_TREE_ID;
  }

  private assertValidScope(scope: SwarmRunScope): void {
    if (!scope.sessionId.trim() || !scope.runId.trim() || !scope.treeId.trim()) {
      throw new Error('SpawnGuard run scope requires non-empty sessionId, runId and treeId.');
    }
  }

  private resolveSlotIdentity(identity?: string | SwarmRunScope): {
    treeId: string;
    scope?: SwarmRunScope;
    key: string;
  } {
    if (typeof identity === 'object') {
      this.assertValidScope(identity);
      const scope = cloneRunScope(identity);
      return { treeId: scope.treeId, scope, key: getSwarmTreeScopeKey(scope) };
    }
    const treeId = this.normalizeTreeId(identity);
    return { treeId, key: `${LEGACY_SLOT_PREFIX}${treeId}` };
  }

  private matchesScope(agent: ManagedAgent, scope?: SpawnGuardScopeFilter): boolean {
    if (!scope) return true;
    // Legacy single-spawn records predate explicit run scope; their treeId is
    // the session id. Keep them visible to session-level callers only.
    if (!agent.sessionId) {
      return !scope.runId && agent.treeId === scope.sessionId;
    }
    if (agent.sessionId !== scope.sessionId) return false;
    if (scope.runId && agent.runId !== scope.runId) return false;
    return !scope.treeId || agent.treeId === scope.treeId;
  }

  private getReservedCountByKey(slotKey: string): number {
    return this.treeSlotCounts.get(slotKey) ?? 0;
  }

  private incrementSlot(slotKey: string): void {
    this.treeSlotCounts.set(slotKey, this.getReservedCountByKey(slotKey) + 1);
  }

  private decrementSlot(slotKey: string): void {
    const current = this.getReservedCountByKey(slotKey);
    if (current <= 0) return;
    if (current <= 1) {
      this.treeSlotCounts.delete(slotKey);
    } else {
      this.treeSlotCounts.set(slotKey, current - 1);
    }
    this.drainQueue(slotKey);
  }

  private createLease(treeId: string, slotKey: string, scope?: SwarmRunScope): SpawnSlotLease {
    let released = false;
    return {
      treeId,
      scope: scope ? cloneRunScope(scope) : undefined,
      release: () => {
        if (released) return;
        released = true;
        this.decrementSlot(slotKey);
      },
    };
  }

  private getQueue(slotKey: string): SlotWaiter[] {
    let queue = this.slotQueues.get(slotKey);
    if (!queue) {
      queue = [];
      this.slotQueues.set(slotKey, queue);
    }
    return queue;
  }

  private removeWaiter(slotKey: string, waiter: SlotWaiter): boolean {
    const queue = this.slotQueues.get(slotKey);
    if (!queue) return false;
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.slotQueues.delete(slotKey);
    return true;
  }

  private cleanupWaiter(waiter: SlotWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private rejectQueuedWaiters(
    matches: (waiter: SlotWaiter) => boolean,
    reason: string,
  ): number {
    let rejected = 0;
    for (const [slotKey, queue] of this.slotQueues) {
      const retained: SlotWaiter[] = [];
      for (const waiter of queue) {
        if (!matches(waiter)) {
          retained.push(waiter);
          continue;
        }
        this.cleanupWaiter(waiter);
        waiter.reject(createSlotCancellationError(waiter.treeId, reason));
        rejected += 1;
      }
      if (retained.length === 0) {
        this.slotQueues.delete(slotKey);
      } else if (retained.length !== queue.length) {
        this.slotQueues.set(slotKey, retained);
      }
    }
    return rejected;
  }

  private drainQueue(slotKey: string): void {
    const queue = this.slotQueues.get(slotKey);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0 && this.getReservedCountByKey(slotKey) < this.maxAgents) {
      const waiter = queue.shift()!;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(createSlotCancellationError(waiter.treeId, waiter.signal.reason));
        continue;
      }
      this.incrementSlot(slotKey);
      waiter.resolve(this.createLease(waiter.treeId, slotKey, waiter.scope));
    }

    if (queue.length === 0) this.slotQueues.delete(slotKey);
  }

  private releaseAgentSlot(agent: ManagedAgent): void {
    if (agent.slotReleased) return;
    agent.slotReleased = true;
    this.decrementSlot(this.resolveSlotIdentity(agent.scope ?? agent.treeId).key);
  }

  /**
   * Register a running agent. Call this after spawning.
   */
  register(
    id: string,
    role: string,
    task: string,
    promise: Promise<SubagentResult>,
    abortController: AbortController,
    options: RegisterOptions = {},
  ): void {
    const parsedIdentity = parseScopedSwarmAgentId(id);
    const scope = options.scope ?? parsedIdentity?.scope;
    if (parsedIdentity && !options.scope && options.slotAcquired) {
      throw new Error('Scoped SpawnGuard registration with a pre-acquired slot requires an explicit run scope.');
    }
    if (scope) {
      this.assertValidScope(scope);
      if (!parsedIdentity || !isSameRunScope(parsedIdentity.scope, scope)) {
        throw new Error('Scoped SpawnGuard agent id does not match the supplied run scope.');
      }
      if (options.treeId && this.normalizeTreeId(options.treeId) !== scope.treeId) {
        throw new Error('SpawnGuard register treeId does not match run scope.');
      }
    }
    const existing = this.agents.get(id);
    if (existing && isLiveRunningStatus(existing.status)) {
      throw new Error(`SpawnGuard agent already registered and running: ${id}`);
    }
    if (existing) {
      this.agents.delete(id);
    }

    const treeId = scope?.treeId ?? this.normalizeTreeId(options.treeId);
    const parentId = options.parentId?.trim() || undefined;
    const parsedParent = parentId ? parseScopedSwarmAgentId(parentId) : null;
    if (
      scope
      && parentId
      && (!parsedParent || !isSameRunScope(parsedParent.scope, scope))
    ) {
      throw new Error('Scoped SpawnGuard parent agent id must belong to the same run scope.');
    }
    if (!options.slotAcquired) {
      this.incrementSlot(this.resolveSlotIdentity(scope ?? treeId).key);
    }

    const agent: ManagedAgent = {
      id,
      role,
      treeId,
      sessionId: scope?.sessionId,
      runId: scope?.runId,
      scope: scope ? cloneRunScope(scope) : undefined,
      parentId,
      status: 'running',
      task,
      promise,
      abortController,
      messageQueue: [],
      createdAt: Date.now(),
    };

    this.agents.set(id, agent);

    // Auto-update status when promise settles + fire onComplete callbacks
    promise.then(
      (result) => {
        const a = this.agents.get(id);
        if (a?.status === 'running') {
          a.status = result.success ? 'completed' : 'failed';
          a.result = result;
          a.error = result.error;
          a.completedAt = Date.now();
          logger.info(`[${id}] Agent completed (${a.status}) in ${a.completedAt - a.createdAt}ms`);
          this.fireOnComplete(a);
          this.releaseAgentSlot(a);
        }
      },
      (err) => {
        const a = this.agents.get(id);
        if (a?.status === 'running') {
          a.status = 'failed';
          a.error = err instanceof Error ? err.message : 'Unknown error';
          a.completedAt = Date.now();
          logger.warn(`[${id}] Agent failed: ${a.error}`);
          this.fireOnComplete(a);
          this.releaseAgentSlot(a);
        }
      }
    );

    logger.info(`[${id}] Registered (${role}), tree: ${treeId}, parent: ${parentId ?? 'none'}, running: ${this.getRunningCount(scope)}/${this.maxAgents}`);
  }

  /**
   * Get a managed agent by ID.
   */
  get(id: string, scope?: SpawnGuardScopeFilter): ManagedAgent | undefined {
    const agent = this.agents.get(id);
    return agent && this.matchesScope(agent, scope) ? agent : undefined;
  }

  /**
   * List all managed agents.
   */
  list(scope?: SpawnGuardScopeFilter): ManagedAgent[] {
    return Array.from(this.agents.values()).filter((agent) => this.matchesScope(agent, scope));
  }

  /**
   * Get the configured maximum concurrent agents.
   */
  getMaxAgents(): number {
    return this.maxAgents;
  }

  /**
   * Get count of currently running agents.
   */
  getRunningCount(scope?: SpawnGuardScopeFilter): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (!this.matchesScope(agent, scope)) continue;
      if (isLiveRunningStatus(agent.status)) count++;
    }
    return count;
  }

  /**
   * Cancel a running agent via its AbortController.
   */
  cancel(id: string, scope?: SpawnGuardScopeFilter): boolean {
    const agent = this.get(id, scope);
    if (!agent || !isLiveRunningStatus(agent.status)) return false;

    this.cancelAgent(agent, 'cancelled');
    this.cancelDescendants(id, 'parent-cancel', scope);
    logger.info(`[${id}] Cancelled with descendants`);
    return true;
  }

  cancelDescendants(
    parentId: string,
    reason: string = 'parent-cancel',
    scope?: SpawnGuardScopeFilter,
  ): number {
    const descendantIds = collectDescendantAgentIds(this.list(scope), parentId);
    let cancelled = 0;
    for (const descendantId of descendantIds) {
      const agent = this.agents.get(descendantId);
      if (!agent || !isLiveRunningStatus(agent.status)) continue;
      this.cancelAgent(agent, reason);
      cancelled += 1;
    }
    if (cancelled > 0) {
      logger.info(`[${parentId}] cancelDescendants: cancelled ${cancelled} descendant agent(s) (${reason})`);
    }
    return cancelled;
  }

  reapOrphanedDescendants(
    reason: string = 'parent-gone',
    scope?: SpawnGuardScopeFilter,
  ): number {
    const orphanIds = collectRunningOrphanAgentIds(this.list(scope));
    let cancelled = 0;
    for (const orphanId of orphanIds) {
      const agent = this.agents.get(orphanId);
      if (!agent || !isLiveRunningStatus(agent.status)) continue;
      this.cancelAgent(agent, reason);
      cancelled += 1;
    }
    if (cancelled > 0) {
      logger.info(`reapOrphanedDescendants: cancelled ${cancelled} orphaned descendant agent(s) (${reason})`);
    }
    return cancelled;
  }

  /**
   * Process-wide shutdown only: cancel every running agent and release slots.
   * User/run/session cancellation must call cancelRun/cancelSession instead.
   *
   * 返回被取消的 agent 数量。
   */
  cancelAll(reason: string = 'app_shutdown'): number {
    this.rejectQueuedWaiters(() => true, reason);
    let cancelled = 0;
    for (const [id, agent] of this.agents) {
      if (isLiveRunningStatus(agent.status)) {
        this.cancelAgent(agent, reason);
        cancelled += 1;
      }
    }
    if (cancelled > 0) {
      logger.info(`cancelAll: cancelled ${cancelled} running agents (${reason})`);
    }
    return cancelled;
  }

  /** Cancel one Team run. This is the normal user-facing swarm cancellation API. */
  cancelRun(scope: SwarmRunRef, reason: string = 'run_cancelled'): number {
    this.rejectQueuedWaiters(
      (waiter) => Boolean(
        waiter.scope?.sessionId === scope.sessionId
        && waiter.scope.runId === scope.runId,
      ),
      reason,
    );
    let cancelled = 0;
    for (const agent of this.list(scope)) {
      if (!isLiveRunningStatus(agent.status)) continue;
      this.cancelAgent(agent, reason);
      cancelled += 1;
    }
    if (cancelled > 0) {
      logger.info(`cancelRun: cancelled ${cancelled} running agents`, scope);
    }
    return cancelled;
  }

  /** Session teardown may span multiple Team runs; still narrower than global cancelAll. */
  cancelSession(sessionId: string, reason: string = 'session_cancelled'): number {
    this.rejectQueuedWaiters(
      (waiter) => waiter.scope?.sessionId === sessionId
        || (!waiter.scope && waiter.treeId === this.normalizeTreeId(sessionId)),
      reason,
    );
    let cancelled = 0;
    for (const agent of this.list({ sessionId })) {
      if (!isLiveRunningStatus(agent.status)) continue;
      this.cancelAgent(agent, reason);
      cancelled += 1;
    }
    return cancelled;
  }

  private cancelAgent(agent: ManagedAgent, reason: string): void {
    try {
      agent.abortController.abort(reason);
    } catch (err) {
      logger.warn(`[${agent.id}] Abort controller threw during cancel`, err);
    }
    agent.status = 'cancelled';
    agent.completedAt = Date.now();
    agent.error = agent.error ?? reason;
    this.releaseAgentSlot(agent);
  }

  /**
   * Wait for specific agents to complete, with timeout.
   * Returns a map of agentId → final status.
   */
  async waitFor(
    ids: string[],
    timeoutMs = 30_000,
    scope?: SpawnGuardScopeFilter,
  ): Promise<Map<string, ManagedAgent>> {
    const results = new Map<string, ManagedAgent>();
    const promises: Promise<void>[] = [];

    for (const id of ids) {
      const agent = this.get(id, scope);
      if (!agent) continue;

      if (!isLiveRunningStatus(agent.status)) {
        results.set(id, agent);
        continue;
      }

      promises.push(
        agent.promise
          .then(() => {
            const current = this.get(id, scope);
            if (current) results.set(id, current);
          })
          .catch(() => {
            const current = this.get(id, scope);
            if (current) results.set(id, current);
          })
      );
    }

    if (promises.length === 0) return results;

    // Race against soft timeout（手工 clearTimeout 避免胜者侧 timer 长留）
    let softTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>(resolve => { softTimeoutId = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (softTimeoutId) clearTimeout(softTimeoutId);
    }

    // Fill in any agents that didn't complete before timeout
    for (const id of ids) {
      if (!results.has(id)) {
        const agent = this.get(id, scope);
        if (agent) results.set(id, agent);
      }
    }

    return results;
  }

  /**
   * Format an async notification when an agent completes (Codex-style XML).
   */
  formatNotification(agent: ManagedAgent): string {
    const data = {
      agent_id: agent.id,
      role: agent.role,
      status: agent.status,
      result: agent.result?.output?.slice(0, 1200),
      stats: {
        tool_calls: agent.result?.toolsUsed.length ?? 0,
        iterations: agent.result?.iterations ?? 0,
        cost: agent.result?.cost,
        duration_ms: agent.completedAt
          ? agent.completedAt - agent.createdAt
          : undefined,
      },
    };
    return `<subagent_notification>\n${JSON.stringify(data, null, 2)}\n</subagent_notification>`;
  }

  /**
   * Send a structured message to a running agent's queue.
   * Supports both string (backward compat) and AgentMessage.
   */
  sendMessage(id: string, message: string | AgentMessage, scope?: SpawnGuardScopeFilter): boolean {
    const agent = this.get(id, scope);
    if (!agent || !isLiveRunningStatus(agent.status)) return false;

    const structured: AgentMessage = typeof message === 'string'
      ? createTextMessage('parent', message)
      : message;
    agent.messageQueue.push(structured);
    logger.info(`[${id}] Message queued (type: ${structured.type}, queue size: ${agent.messageQueue.length})`);
    return true;
  }

  /**
   * Send a structured message by type (convenience method).
   */
  sendStructuredMessage(
    id: string,
    type: AgentMessageType,
    from: string,
    payload: Record<string, unknown>,
    scope?: SpawnGuardScopeFilter,
  ): boolean {
    return this.sendMessage(id, createAgentMessage(type, from, payload), scope);
  }

  /**
   * 非破坏性查看某 agent 的待办消息（swarm 护栏 P1-2 #4 桥接用）。
   * 返回队列副本——不消费，drainMessages 仍能取到，便于统一 inbox 门面只读聚合。
   */
  peekMessages(id: string, scope?: SpawnGuardScopeFilter): AgentMessage[] {
    const agent = this.get(id, scope);
    return agent ? [...agent.messageQueue] : [];
  }

  /**
   * Drain all pending messages for an agent (called by executor).
   */
  drainMessages(id: string, scope?: SpawnGuardScopeFilter): AgentMessage[] {
    const agent = this.get(id, scope);
    if (!agent || agent.messageQueue.length === 0) return [];
    const messages = [...agent.messageQueue];
    agent.messageQueue.length = 0;
    return messages;
  }

  /**
   * Drain only messages of a specific type (e.g., shutdown_request).
   */
  drainMessagesByType(
    id: string,
    type: AgentMessageType,
    scope?: SpawnGuardScopeFilter,
  ): AgentMessage[] {
    const agent = this.get(id, scope);
    if (!agent) return [];
    const matching = agent.messageQueue.filter(m => m.type === type);
    agent.messageQueue = agent.messageQueue.filter(m => m.type !== type);
    return matching;
  }

  /**
   * Register a callback to be invoked when any agent completes.
   * Used by spawnAgent to inject async notifications into parent context.
   */
  onComplete(callback: OnAgentCompleteCallback): void {
    this.onCompleteCallbacks.push(callback);
  }

  /**
   * Fire all onComplete callbacks for a finished agent.
   * Also auto-queue a notification for the parent agent to pick up.
   */
  private fireOnComplete(agent: ManagedAgent): void {
    // Auto-queue notification for parent agent (Codex-style async notification)
    this.pendingNotifications.push({
      sessionId: agent.sessionId,
      runId: agent.runId,
      treeId: agent.treeId,
      content: this.formatNotification(agent),
    });

    for (const cb of this.onCompleteCallbacks) {
      try {
        cb(agent);
      } catch (err) {
        logger.warn(`[${agent.id}] onComplete callback error:`, err);
      }
    }
  }

  /**
   * Drain all pending completion notifications.
   * Called by contextAssembly each inference turn to inject into parent agent.
   */
  drainNotifications(scope?: SpawnGuardScopeFilter): string[] {
    if (this.pendingNotifications.length === 0) return [];
    if (!scope) {
      const notifications = this.pendingNotifications.map((entry) => entry.content);
      this.pendingNotifications.length = 0;
      return notifications;
    }

    const matched: string[] = [];
    const remaining: PendingAgentNotification[] = [];
    for (const entry of this.pendingNotifications) {
      if (this.matchesNotificationScope(entry, scope)) {
        matched.push(entry.content);
      } else {
        remaining.push(entry);
      }
    }
    this.pendingNotifications = remaining;
    return matched;
  }

  /**
   * Check if all blockers for a given task are completed.
   */
  isTaskReady(
    taskId: string,
    blockedBy: Set<string>,
    scope?: SpawnGuardScopeFilter,
  ): boolean {
    for (const blockerId of blockedBy) {
      const blocker = this.get(blockerId, scope);
      if (!blocker || isLiveRunningStatus(blocker.status)) return false;
    }
    return true;
  }

  /**
   * Cleanup completed/failed agents older than maxAge.
   */
  cleanup(maxAgeMs = 300_000, scope?: SpawnGuardScopeFilter): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, agent] of this.agents) {
      if (!this.matchesScope(agent, scope)) continue;
      if (!isLiveRunningStatus(agent.status) && now - agent.createdAt > maxAgeMs) {
        this.agents.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info(`Cleaned up ${removed} stale agents`);
    }
    return removed;
  }

  private matchesNotificationScope(
    entry: PendingAgentNotification,
    scope: SpawnGuardScopeFilter,
  ): boolean {
    if (!entry.sessionId) {
      return !scope.runId && entry.treeId === scope.sessionId;
    }
    if (entry.sessionId !== scope.sessionId) return false;
    if (scope.runId && entry.runId !== scope.runId) return false;
    return !scope.treeId || entry.treeId === scope.treeId;
  }

  /**
   * Get the list of tools that subagents should NOT have access to.
   */
  getDisabledTools(): string[] {
    return SUBAGENT_DISABLED_TOOLS;
  }

  /**
   * Get additional disabled tools for read-only roles (explorer, reviewer).
   * These roles should not modify files — enforce at tool level, not just prompt level.
   */
  getReadonlyDisabledTools(): string[] {
    return [...SUBAGENT_DISABLED_TOOLS, ...READONLY_DISABLED_TOOLS];
  }

  // ==========================================================================
  // 状态持久化 + 恢复
  // ==========================================================================

  /**
   * Persist SpawnGuard state to disk for crash recovery.
   * Stores agent metadata, message queues, and pending notifications.
   */
  async persistState(sessionDir: string, scope?: SwarmRunScope): Promise<void> {
    if (scope) this.assertValidScope(scope);
    const persistedScope = scope ? cloneRunScope(scope) : undefined;
    const state: PersistedSpawnGuardState = {
      scope: persistedScope,
      agents: this.list(persistedScope).map((agent) => ({
        id: agent.id,
        role: agent.role,
        treeId: agent.treeId,
        sessionId: agent.sessionId,
        runId: agent.runId,
        parentId: agent.parentId,
        status: agent.status,
        task: agent.task,
        messageQueue: agent.messageQueue,
        createdAt: agent.createdAt,
        completedAt: agent.completedAt,
        // Only persist results for completed agents (running agents can't be serialized)
        result: agent.status !== 'running' ? agent.result : undefined,
        error: agent.error,
        recoveryPlan: agent.recoveryPlan,
      })),
      pendingNotifications: persistedScope
        ? this.pendingNotifications.filter((entry) => this.matchesNotificationScope(entry, persistedScope))
        : [...this.pendingNotifications],
      persistedAt: Date.now(),
    };

    const filePath = getSpawnGuardStatePath(sessionDir, persistedScope);
    await writeFile(filePath, JSON.stringify(state, null, 2));
    logger.info(`State persisted to ${filePath} (${state.agents.length} agents)`);
  }

  /**
   * Restore SpawnGuard state from disk.
   * Running agents are restored as dead-log-only instead of failed: the app can
   * show the interrupted work without pretending a live child process still
   * exists.
   * Message queues and pending notifications are restored.
   */
  static async restoreState(
    sessionDir: string,
    scope?: SwarmRunScope,
  ): Promise<SpawnGuard | null> {
    if (scope && (!scope.sessionId.trim() || !scope.runId.trim() || !scope.treeId.trim())) {
      return null;
    }
    const expectedScope = scope ? cloneRunScope(scope) : undefined;
    const filePath = getSpawnGuardStatePath(sessionDir, expectedScope);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const raw = await readFile(filePath, 'utf-8');
      const state = JSON.parse(raw) as PersistedSpawnGuardState;

      if (
        expectedScope
        && (!state.scope || !isSameRunScope(state.scope, expectedScope))
      ) {
        logger.warn('SpawnGuard persisted scope mismatch, ignoring', {
          expected: expectedScope,
          actual: state.scope,
        });
        return null;
      }

      const guard = new SpawnGuard();

      for (const entry of state.agents) {
        const entryScope = entry.sessionId && entry.runId && entry.treeId
          ? { sessionId: entry.sessionId, runId: entry.runId, treeId: entry.treeId }
          : undefined;
        const parsedIdentity = parseScopedSwarmAgentId(entry.id);
        const requiredScope = expectedScope ?? state.scope;
        if (
          requiredScope
          && (
            !entryScope
            || !parsedIdentity
            || !isSameRunScope(entryScope, requiredScope)
            || !isSameRunScope(parsedIdentity.scope, requiredScope)
          )
        ) {
          throw new Error(`Persisted SpawnGuard agent scope mismatch: ${entry.id}`);
        }
        if (
          parsedIdentity
          && (!entryScope || !isSameRunScope(parsedIdentity.scope, entryScope))
        ) {
          throw new Error(`Persisted scoped agent identity is inconsistent: ${entry.id}`);
        }

        const wasRunning = isLiveRunningStatus(entry.status);
        const status: ManagedAgentStatus = wasRunning ? 'dead-log-only' : entry.status;
        const recoveredAt = Date.now();
        const recoveryPlan = entry.recoveryPlan ?? buildManagedAgentRecoveryPlan(entry.status, wasRunning);
        const agent: ManagedAgent = {
          id: entry.id,
          role: entry.role,
          treeId: entry.treeId ?? DEFAULT_TREE_ID,
          sessionId: entryScope?.sessionId,
          runId: entryScope?.runId,
          scope: entryScope ? cloneRunScope(entryScope) : undefined,
          parentId: entry.parentId,
          status,
          task: entry.task,
          promise: Promise.resolve(entry.result ?? {
            success: false,
            output: '',
            error: 'Subagent live execution was not recovered after restart; log is available only',
            iterations: 0,
            toolsUsed: [],
            cost: 0,
          }),
          abortController: new AbortController(),
          result: entry.result,
          error: wasRunning ? 'Subagent process was not recovered after restart; log is available only' : entry.error,
          recoveryPlan,
          messageQueue: entry.messageQueue || [],
          createdAt: entry.createdAt,
          completedAt: entry.completedAt ?? (wasRunning ? recoveredAt : undefined),
        };

        guard.agents.set(entry.id, agent);
      }

      // Restore pending notifications
      guard.pendingNotifications = (state.pendingNotifications || []).map((entry) => {
        if (typeof entry === 'string') {
          if (expectedScope) {
            throw new Error('Scoped SpawnGuard snapshot contains an unscoped notification.');
          }
          return { treeId: DEFAULT_TREE_ID, content: entry };
        }
        if (expectedScope && !guard.matchesNotificationScope(entry, expectedScope)) {
          throw new Error('Persisted SpawnGuard notification scope mismatch.');
        }
        return entry;
      });

      logger.info(`State restored from ${filePath}: ${state.agents.length} agents, ${guard.pendingNotifications.length} pending notifications`);
      return guard;
    } catch (err) {
      logger.warn('Failed to restore SpawnGuard state:', err);
      return null;
    }
  }
}

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

// ============================================================================
// Singleton
// ============================================================================

let instance: SpawnGuard | null = null;

export function getSpawnGuard(config?: SpawnGuardConfig): SpawnGuard {
  if (!instance) {
    instance = new SpawnGuard(config);
  }
  return instance;
}

export function resetSpawnGuard(): void {
  instance = null;
}
