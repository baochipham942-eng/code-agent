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
import { createLogger } from '../services/infra/logger';
import { SPAWN_GUARD } from '../../shared/constants/agent';
import { READONLY_TOOL_DENYLIST } from './routingToolPolicy';
import type { SubagentResult } from './subagentExecutorTypes';
import {
  collectDescendantAgentIds,
  collectRunningOrphanAgentIds,
} from './orphanLiveness';

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
}

/** Serializable snapshot of SpawnGuard state for crash recovery */
interface PersistedSpawnGuardState {
  agents: Array<{
    id: string;
    role: string;
    treeId?: string;
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
  pendingNotifications: string[];
  persistedAt: number;
}

export interface SpawnSlotLease {
  treeId: string;
  release: () => void;
}

interface SlotWaiter {
  resolve: (lease: SpawnSlotLease) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// SpawnGuard
// ============================================================================

const DEFAULT_MAX_AGENTS = SPAWN_GUARD.MAX_TREE_AGENTS;
const DEFAULT_MAX_DEPTH = SPAWN_GUARD.DEFAULT_SPAWN_DEPTH;
const HARD_MAX_DEPTH = SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH;
const DEFAULT_QUEUE_TIMEOUT_MS = SPAWN_GUARD.QUEUE_WAIT_TIMEOUT_MS;
const DEFAULT_TREE_ID = 'default';

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
  private pendingNotifications: string[] = [];

  constructor(config: SpawnGuardConfig = {}) {
    this.maxAgents = config.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.maxDepth = this.clampDepth(config.maxDepth ?? DEFAULT_MAX_DEPTH);
  }

  /**
   * Try to reserve a slot for a new agent.
   * Returns false if at capacity.
   */
  canSpawn(treeId: string = DEFAULT_TREE_ID): boolean {
    return this.getReservedCount(treeId) < this.maxAgents;
  }

  /**
   * Acquire a slot in the root tree pool. Over-capacity callers wait FIFO.
   */
  async acquireSlot(options: {
    treeId?: string;
    timeoutMs?: number;
  } = {}): Promise<SpawnSlotLease> {
    const treeId = this.normalizeTreeId(options.treeId);
    if (this.canSpawn(treeId)) {
      this.incrementSlot(treeId);
      return this.createLease(treeId);
    }

    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS));
    return new Promise<SpawnSlotLease>((resolve, reject) => {
      const waiter: SlotWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(treeId, waiter);
          reject(new Error(`Spawn slot wait timed out for tree ${treeId} after ${timeoutMs}ms (running ${this.getReservedCount(treeId)}, max ${this.maxAgents})`));
        }, timeoutMs),
      };
      this.getQueue(treeId).push(waiter);
      logger.info(`[${treeId}] Spawn queued (${this.getReservedCount(treeId)}/${this.maxAgents}, queue: ${this.getQueue(treeId).length})`);
    });
  }

  getReservedCount(treeId: string = DEFAULT_TREE_ID): number {
    return this.treeSlotCounts.get(this.normalizeTreeId(treeId)) ?? 0;
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

  private incrementSlot(treeId: string): void {
    this.treeSlotCounts.set(treeId, this.getReservedCount(treeId) + 1);
  }

  private decrementSlot(treeId: string): void {
    const current = this.getReservedCount(treeId);
    if (current <= 1) {
      this.treeSlotCounts.delete(treeId);
    } else {
      this.treeSlotCounts.set(treeId, current - 1);
    }
    this.drainQueue(treeId);
  }

  private createLease(treeId: string): SpawnSlotLease {
    let released = false;
    return {
      treeId,
      release: () => {
        if (released) return;
        released = true;
        this.decrementSlot(treeId);
      },
    };
  }

  private getQueue(treeId: string): SlotWaiter[] {
    let queue = this.slotQueues.get(treeId);
    if (!queue) {
      queue = [];
      this.slotQueues.set(treeId, queue);
    }
    return queue;
  }

  private removeWaiter(treeId: string, waiter: SlotWaiter): void {
    const queue = this.slotQueues.get(treeId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.slotQueues.delete(treeId);
  }

  private drainQueue(treeId: string): void {
    const queue = this.slotQueues.get(treeId);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0 && this.canSpawn(treeId)) {
      const waiter = queue.shift()!;
      clearTimeout(waiter.timer);
      this.incrementSlot(treeId);
      waiter.resolve(this.createLease(treeId));
    }

    if (queue.length === 0) this.slotQueues.delete(treeId);
  }

  private releaseAgentSlot(agent: ManagedAgent): void {
    if (agent.slotReleased) return;
    agent.slotReleased = true;
    this.decrementSlot(agent.treeId);
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
    const treeId = this.normalizeTreeId(options.treeId);
    const parentId = options.parentId?.trim() || undefined;
    if (!options.slotAcquired) {
      this.incrementSlot(treeId);
    }

    const agent: ManagedAgent = {
      id,
      role,
      treeId,
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

    logger.info(`[${id}] Registered (${role}), tree: ${treeId}, parent: ${parentId ?? 'none'}, running: ${this.getRunningCount()}/${this.maxAgents}`);
  }

  /**
   * Get a managed agent by ID.
   */
  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * List all managed agents.
   */
  list(): ManagedAgent[] {
    return Array.from(this.agents.values());
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
  getRunningCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (isLiveRunningStatus(agent.status)) count++;
    }
    return count;
  }

  /**
   * Cancel a running agent via its AbortController.
   */
  cancel(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || !isLiveRunningStatus(agent.status)) return false;

    this.cancelAgent(agent, 'cancelled');
    this.cancelDescendants(id, 'parent-cancel');
    logger.info(`[${id}] Cancelled with descendants`);
    return true;
  }

  cancelDescendants(parentId: string, reason: string = 'parent-cancel'): number {
    const descendantIds = collectDescendantAgentIds(this.list(), parentId);
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

  reapOrphanedDescendants(reason: string = 'parent-gone'): number {
    const orphanIds = collectRunningOrphanAgentIds(this.list());
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
   * Cancel all running agents and release their slots.
   * ADR-010 #6：swarm 整体取消时调用，保证 spawnGuard 配额立即释放、
   * 在途 LLM 流的 AbortController 被触发。
   *
   * 返回被取消的 agent 数量。
   */
  cancelAll(reason: string = 'cancelled'): number {
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
    timeoutMs = 30_000
  ): Promise<Map<string, ManagedAgent>> {
    const results = new Map<string, ManagedAgent>();
    const promises: Promise<void>[] = [];

    for (const id of ids) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      if (!isLiveRunningStatus(agent.status)) {
        results.set(id, agent);
        continue;
      }

      promises.push(
        agent.promise
          .then(() => { results.set(id, this.agents.get(id)!); })
          .catch(() => { results.set(id, this.agents.get(id)!); })
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
        const agent = this.agents.get(id);
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
  sendMessage(id: string, message: string | AgentMessage): boolean {
    const agent = this.agents.get(id);
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
    payload: Record<string, unknown>
  ): boolean {
    return this.sendMessage(id, createAgentMessage(type, from, payload));
  }

  /**
   * 非破坏性查看某 agent 的待办消息（swarm 护栏 P1-2 #4 桥接用）。
   * 返回队列副本——不消费，drainMessages 仍能取到，便于统一 inbox 门面只读聚合。
   */
  peekMessages(id: string): AgentMessage[] {
    const agent = this.agents.get(id);
    return agent ? [...agent.messageQueue] : [];
  }

  /**
   * Drain all pending messages for an agent (called by executor).
   */
  drainMessages(id: string): AgentMessage[] {
    const agent = this.agents.get(id);
    if (!agent || agent.messageQueue.length === 0) return [];
    const messages = [...agent.messageQueue];
    agent.messageQueue.length = 0;
    return messages;
  }

  /**
   * Drain only messages of a specific type (e.g., shutdown_request).
   */
  drainMessagesByType(id: string, type: AgentMessageType): AgentMessage[] {
    const agent = this.agents.get(id);
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
    this.pendingNotifications.push(this.formatNotification(agent));

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
  drainNotifications(): string[] {
    if (this.pendingNotifications.length === 0) return [];
    const notifications = [...this.pendingNotifications];
    this.pendingNotifications.length = 0;
    return notifications;
  }

  /**
   * Check if all blockers for a given task are completed.
   */
  isTaskReady(taskId: string, blockedBy: Set<string>): boolean {
    for (const blockerId of blockedBy) {
      const blocker = this.agents.get(blockerId);
      if (!blocker || isLiveRunningStatus(blocker.status)) return false;
    }
    return true;
  }

  /**
   * Cleanup completed/failed agents older than maxAge.
   */
  cleanup(maxAgeMs = 300_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, agent] of this.agents) {
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
  async persistState(sessionDir: string): Promise<void> {
    const state: PersistedSpawnGuardState = {
      agents: Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        role: agent.role,
        treeId: agent.treeId,
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
      pendingNotifications: [...this.pendingNotifications],
      persistedAt: Date.now(),
    };

    const filePath = join(sessionDir, 'spawn-guard-state.json');
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
  static async restoreState(sessionDir: string): Promise<SpawnGuard | null> {
    const filePath = join(sessionDir, 'spawn-guard-state.json');
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const raw = await readFile(filePath, 'utf-8');
      const state = JSON.parse(raw) as PersistedSpawnGuardState;

      const guard = new SpawnGuard();

      for (const entry of state.agents) {
        const wasRunning = entry.status === 'running';
        const status: ManagedAgentStatus = wasRunning ? 'dead-log-only' : entry.status;
        const recoveredAt = Date.now();
        const recoveryPlan = entry.recoveryPlan ?? buildManagedAgentRecoveryPlan(entry.status, wasRunning);
        const agent: ManagedAgent = {
          id: entry.id,
          role: entry.role,
          treeId: entry.treeId ?? DEFAULT_TREE_ID,
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
      guard.pendingNotifications = state.pendingNotifications || [];

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
