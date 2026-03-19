// ============================================================================
// SpawnGuard - 子代理并发守卫 + 生命周期管理
// ============================================================================
//
// 借鉴 Codex CLI 的 guards.rs：
// - 并发限制（MAX_AGENTS / MAX_DEPTH）
// - 持有 executor promise + AbortController 引用
// - RAII 风格 reserve/release
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { SubagentResult } from './subagentExecutor';

const logger = createLogger('SpawnGuard');

// ============================================================================
// Types
// ============================================================================

export interface ManagedAgent {
  id: string;
  role: string;
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
  /** Message queue for send_input (consumed by executor each iteration) */
  messageQueue: string[];
  createdAt: number;
  completedAt?: number;
}

export type ManagedAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SpawnGuardConfig {
  /** Maximum concurrent agents (default 6) */
  maxAgents?: number;
  /** Maximum nesting depth (default 1 — sub-agents cannot spawn sub-agents) */
  maxDepth?: number;
}

// ============================================================================
// SpawnGuard
// ============================================================================

const DEFAULT_MAX_AGENTS = 6;
const DEFAULT_MAX_DEPTH = 1;

export type OnAgentCompleteCallback = (agent: ManagedAgent) => void;

class SpawnGuard {
  private agents: Map<string, ManagedAgent> = new Map();
  private maxAgents: number;
  private maxDepth: number;
  private onCompleteCallbacks: OnAgentCompleteCallback[] = [];
  /** Pending completion notifications for parent agent to drain each turn */
  private pendingNotifications: string[] = [];

  constructor(config: SpawnGuardConfig = {}) {
    this.maxAgents = config.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Try to reserve a slot for a new agent.
   * Returns false if at capacity.
   */
  canSpawn(): boolean {
    const running = this.getRunningCount();
    return running < this.maxAgents;
  }

  /**
   * Check if spawning is allowed at the given depth.
   */
  checkDepth(depth: number): boolean {
    return depth <= this.maxDepth;
  }

  /**
   * Register a running agent. Call this after spawning.
   */
  register(
    id: string,
    role: string,
    task: string,
    promise: Promise<SubagentResult>,
    abortController: AbortController
  ): void {
    const agent: ManagedAgent = {
      id,
      role,
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
        if (a && a.status === 'running') {
          a.status = result.success ? 'completed' : 'failed';
          a.result = result;
          a.error = result.error;
          a.completedAt = Date.now();
          logger.info(`[${id}] Agent completed (${a.status}) in ${a.completedAt - a.createdAt}ms`);
          this.fireOnComplete(a);
        }
      },
      (err) => {
        const a = this.agents.get(id);
        if (a && a.status === 'running') {
          a.status = 'failed';
          a.error = err instanceof Error ? err.message : 'Unknown error';
          a.completedAt = Date.now();
          logger.warn(`[${id}] Agent failed: ${a.error}`);
          this.fireOnComplete(a);
        }
      }
    );

    logger.info(`[${id}] Registered (${role}), running: ${this.getRunningCount()}/${this.maxAgents}`);
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
      if (agent.status === 'running') count++;
    }
    return count;
  }

  /**
   * Cancel a running agent via its AbortController.
   */
  cancel(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return false;

    agent.abortController.abort('cancelled');
    agent.status = 'cancelled';
    agent.completedAt = Date.now();
    logger.info(`[${id}] Cancelled`);
    return true;
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

      if (agent.status !== 'running') {
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

    // Race against timeout
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);

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
   * Send a message to a running agent's queue.
   * The executor drains this queue at the start of each iteration.
   */
  sendMessage(id: string, message: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.messageQueue.push(message);
    logger.info(`[${id}] Message queued (queue size: ${agent.messageQueue.length})`);
    return true;
  }

  /**
   * Drain all pending messages for an agent (called by executor).
   */
  drainMessages(id: string): string[] {
    const agent = this.agents.get(id);
    if (!agent || agent.messageQueue.length === 0) return [];
    const messages = [...agent.messageQueue];
    agent.messageQueue.length = 0;
    return messages;
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
   * Cleanup completed/failed agents older than maxAge.
   */
  cleanup(maxAgeMs = 300_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status !== 'running' && now - agent.createdAt > maxAgeMs) {
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
}

/**
 * Tools disabled for all subagents (three-way consensus: CC + Codex + Cline)
 */
const SUBAGENT_DISABLED_TOOLS = [
  'spawn_agent',        // 子不启子（max_depth=1）
  'AgentSpawn',         // PascalCase alias
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
  'workflow_orchestrate',
  'WorkflowOrchestrate',
  'teammate',
  'Teammate',
  'Task',               // SDK Task 工具（可间接 spawn agent）
  'plan_review',        // 跨 agent 审批（子代理不应自审）
  'PlanReview',
];

/**
 * Additional tools disabled for read-only roles (explorer, reviewer)
 * Enforces immutability at tool level, not just prompt level.
 */
const READONLY_DISABLED_TOOLS = [
  'write_file',
  'Write',
  'edit_file',
  'Edit',
];

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
