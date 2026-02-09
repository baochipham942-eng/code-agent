// ============================================================================
// Task Claim Service - 乐观锁任务认领
// ============================================================================
// 松耦合任务场景下，用乐观并发控制替代 DAG 预排。
// Agent 自选任务，锁过期自动释放。
//
// Electron 单线程保证 JS 级原子性，无需真正的文件锁。
// 5 分钟锁过期防止死锁。
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TaskClaimService');

// ============================================================================
// Types
// ============================================================================

export interface ClaimableTask {
  id: string;
  description: string;
  priority: number; // Lower = higher priority
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface TaskClaim {
  taskId: string;
  agentId: string;
  claimedAt: number;
  expiresAt: number;
}

export type TaskClaimStatus = 'available' | 'claimed' | 'completed' | 'failed';

interface TaskEntry {
  task: ClaimableTask;
  status: TaskClaimStatus;
  claim?: TaskClaim;
  result?: string;
  error?: string;
  completedAt?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default claim lock timeout: 5 minutes */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Cleanup interval: 30 seconds */
const CLEANUP_INTERVAL_MS = 30 * 1000;

// ============================================================================
// Task Claim Service
// ============================================================================

export class TaskClaimService {
  private tasks: Map<string, TaskEntry> = new Map();
  private lockTimeoutMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {
    this.lockTimeoutMs = lockTimeoutMs;
  }

  /**
   * Start automatic cleanup of expired claims
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.releaseExpiredClaims(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop automatic cleanup
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Add tasks to the pool
   */
  addTasks(tasks: ClaimableTask[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, {
        task,
        status: 'available',
      });
    }
    logger.info(`Added ${tasks.length} tasks to pool (total: ${this.tasks.size})`);
  }

  /**
   * Try to claim the next available task for an agent
   *
   * Picks the highest-priority (lowest number) available task.
   * Returns null if no tasks are available.
   */
  claimNext(agentId: string, preferTags?: string[]): ClaimableTask | null {
    // Release any expired claims first
    this.releaseExpiredClaims();

    // Find available tasks, sorted by priority
    const available = Array.from(this.tasks.values())
      .filter(e => e.status === 'available')
      .sort((a, b) => {
        // Prefer matching tags
        if (preferTags && preferTags.length > 0) {
          const aMatch = a.task.tags.some(t => preferTags.includes(t));
          const bMatch = b.task.tags.some(t => preferTags.includes(t));
          if (aMatch && !bMatch) return -1;
          if (!aMatch && bMatch) return 1;
        }
        return a.task.priority - b.task.priority;
      });

    if (available.length === 0) {
      return null;
    }

    const entry = available[0];
    return this.claim(entry.task.id, agentId);
  }

  /**
   * Claim a specific task
   */
  claim(taskId: string, agentId: string): ClaimableTask | null {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.status !== 'available') {
      return null;
    }

    const now = Date.now();
    entry.status = 'claimed';
    entry.claim = {
      taskId,
      agentId,
      claimedAt: now,
      expiresAt: now + this.lockTimeoutMs,
    };

    logger.debug(`Task ${taskId} claimed by ${agentId}`);
    return entry.task;
  }

  /**
   * Release a task claim (task goes back to available)
   */
  release(taskId: string, agentId: string): boolean {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.status !== 'claimed' || entry.claim?.agentId !== agentId) {
      return false;
    }

    entry.status = 'available';
    entry.claim = undefined;
    logger.debug(`Task ${taskId} released by ${agentId}`);
    return true;
  }

  /**
   * Mark a task as completed
   */
  complete(taskId: string, agentId: string, result: string): boolean {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.claim?.agentId !== agentId) {
      return false;
    }

    entry.status = 'completed';
    entry.result = result;
    entry.completedAt = Date.now();
    logger.debug(`Task ${taskId} completed by ${agentId}`);
    return true;
  }

  /**
   * Mark a task as failed (goes back to available for retry)
   */
  fail(taskId: string, agentId: string, error: string): boolean {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.claim?.agentId !== agentId) {
      return false;
    }

    entry.status = 'available';
    entry.claim = undefined;
    entry.error = error;
    logger.debug(`Task ${taskId} failed by ${agentId}, returning to pool`);
    return true;
  }

  /**
   * Get available task count
   */
  getAvailableCount(): number {
    return Array.from(this.tasks.values()).filter(e => e.status === 'available').length;
  }

  /**
   * Get all tasks with their status
   */
  getAllTasks(): Array<{ task: ClaimableTask; status: TaskClaimStatus; claimedBy?: string }> {
    return Array.from(this.tasks.values()).map(e => ({
      task: e.task,
      status: e.status,
      claimedBy: e.claim?.agentId,
    }));
  }

  /**
   * Check if all tasks are done (completed or failed)
   */
  isAllDone(): boolean {
    for (const entry of this.tasks.values()) {
      if (entry.status === 'available' || entry.status === 'claimed') {
        return false;
      }
    }
    return this.tasks.size > 0;
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    available: number;
    claimed: number;
    completed: number;
    failed: number;
  } {
    let available = 0;
    let claimed = 0;
    let completed = 0;
    let failed = 0;

    for (const entry of this.tasks.values()) {
      switch (entry.status) {
        case 'available': available++; break;
        case 'claimed': claimed++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }

    return { total: this.tasks.size, available, claimed, completed, failed };
  }

  /**
   * Release all expired claims
   */
  private releaseExpiredClaims(): void {
    const now = Date.now();
    for (const entry of this.tasks.values()) {
      if (entry.status === 'claimed' && entry.claim && entry.claim.expiresAt <= now) {
        logger.warn(`Claim expired for task ${entry.task.id} (agent: ${entry.claim.agentId})`);
        entry.status = 'available';
        entry.claim = undefined;
      }
    }
  }

  /**
   * Reset all tasks
   */
  reset(): void {
    this.stopCleanup();
    this.tasks.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: TaskClaimService | null = null;

export function getTaskClaimService(): TaskClaimService {
  if (!instance) {
    instance = new TaskClaimService();
    instance.startCleanup();
  }
  return instance;
}
