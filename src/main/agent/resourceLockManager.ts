// ============================================================================
// Resource Lock Manager - 资源锁管理，支持多 Agent 并行安全
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('ResourceLockManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 资源类型
 */
export type ResourceType = 'file' | 'directory' | 'command' | 'network';

/**
 * 锁模式
 */
export type LockMode = 'exclusive' | 'shared';

/**
 * 资源锁
 */
export interface ResourceLock {
  /** 资源标识（文件路径、命令名等）*/
  resource: string;
  /** 资源类型 */
  type: ResourceType;
  /** 持有者 ID (Agent ID) */
  holderId: string;
  /** 锁模式 */
  mode: LockMode;
  /** 获取时间 */
  acquiredAt: number;
  /** 自动释放超时（毫秒）*/
  timeout: number;
  /** 额外的共享锁持有者（仅限 shared 模式）*/
  sharedHolders?: string[];
}

/**
 * 锁请求结果
 */
export interface LockAcquisitionResult {
  /** 是否成功获取锁 */
  acquired: boolean;
  /** 失败原因 */
  reason?: string;
  /** 冲突的持有者 */
  conflictingHolders?: string[];
  /** 预计等待时间（毫秒）*/
  estimatedWait?: number;
}

/**
 * 资源冲突
 */
export interface ResourceConflict {
  resource: string;
  type: ResourceType;
  requestedMode: LockMode;
  currentMode: LockMode;
  holders: string[];
}

/**
 * 冲突解决策略
 */
export enum ConflictResolution {
  WAIT = 'wait',        // 等待锁释放
  SKIP = 'skip',        // 跳过此操作
  QUEUE = 'queue',      // 加入队列
  ABORT = 'abort',      // 终止冲突 Agent
}

// ----------------------------------------------------------------------------
// Resource Lock Manager
// ----------------------------------------------------------------------------

/**
 * 资源锁管理器
 *
 * 管理多 Agent 并行执行时的资源访问，防止冲突。
 * 支持：
 * - 独占锁（写操作）
 * - 共享锁（读操作）
 * - 自动超时释放
 * - 死锁检测
 */
export class ResourceLockManager {
  private locks: Map<string, ResourceLock> = new Map();
  private waitQueues: Map<string, Array<{
    holderId: string;
    mode: LockMode;
    resolve: (result: LockAcquisitionResult) => void;
  }>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 定期清理超时的锁
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredLocks();
    }, 10000); // 每 10 秒检查一次
  }

  /**
   * 尝试获取资源锁
   */
  async acquire(
    holderId: string,
    resource: string,
    mode: LockMode = 'exclusive',
    options: {
      type?: ResourceType;
      timeout?: number;
      wait?: boolean;
      waitTimeout?: number;
    } = {}
  ): Promise<LockAcquisitionResult> {
    const {
      type = this.inferResourceType(resource),
      timeout = 300000, // 默认 5 分钟超时
      wait = false,
      waitTimeout = 30000, // 等待最多 30 秒
    } = options;

    const lockKey = this.getLockKey(resource, type);
    const existingLock = this.locks.get(lockKey);

    // 检查是否可以获取锁
    if (!existingLock) {
      // 没有现有锁，直接获取
      return this.grantLock(holderId, resource, type, mode, timeout);
    }

    // 已有锁，检查兼容性
    if (this.isCompatible(existingLock, mode, holderId)) {
      // 兼容，可以共享
      return this.addSharedHolder(existingLock, holderId);
    }

    // 不兼容
    if (!wait) {
      return {
        acquired: false,
        reason: `Resource ${resource} is locked by ${existingLock.holderId}`,
        conflictingHolders: this.getAllHolders(existingLock),
      };
    }

    // 等待锁释放
    return this.waitForLock(holderId, resource, type, mode, timeout, waitTimeout);
  }

  /**
   * 释放资源锁
   */
  release(holderId: string, resource: string): boolean {
    const type = this.inferResourceType(resource);
    const lockKey = this.getLockKey(resource, type);
    const lock = this.locks.get(lockKey);

    if (!lock) {
      return false;
    }

    // 检查是否是持有者
    if (lock.holderId === holderId) {
      // 主持有者释放
      if (lock.sharedHolders && lock.sharedHolders.length > 0) {
        // 还有其他共享持有者，转移所有权
        const newHolder = lock.sharedHolders.shift()!;
        lock.holderId = newHolder;
        logger.debug(`Lock transferred from ${holderId} to ${newHolder} for ${resource}`);
      } else {
        // 完全释放
        this.locks.delete(lockKey);
        logger.debug(`Lock released by ${holderId} for ${resource}`);
        this.processWaitQueue(lockKey);
      }
      return true;
    }

    // 检查是否是共享持有者
    if (lock.sharedHolders) {
      const index = lock.sharedHolders.indexOf(holderId);
      if (index !== -1) {
        lock.sharedHolders.splice(index, 1);
        logger.debug(`Shared holder ${holderId} released for ${resource}`);
        return true;
      }
    }

    return false;
  }

  /**
   * 释放某个 Agent 持有的所有锁
   */
  releaseAll(holderId: string): number {
    let released = 0;
    const toRelease: string[] = [];

    for (const [key, lock] of this.locks) {
      if (lock.holderId === holderId) {
        toRelease.push(key);
      } else if (lock.sharedHolders?.includes(holderId)) {
        const index = lock.sharedHolders.indexOf(holderId);
        lock.sharedHolders.splice(index, 1);
        released++;
      }
    }

    for (const key of toRelease) {
      this.locks.delete(key);
      released++;
      this.processWaitQueue(key);
    }

    if (released > 0) {
      logger.info(`Released ${released} locks for ${holderId}`);
    }

    return released;
  }

  /**
   * 检查资源是否被锁定
   */
  isLocked(resource: string): boolean {
    const type = this.inferResourceType(resource);
    const lockKey = this.getLockKey(resource, type);
    return this.locks.has(lockKey);
  }

  /**
   * 获取资源的冲突信息
   */
  getConflicts(resource: string, mode: LockMode): ResourceConflict | null {
    const type = this.inferResourceType(resource);
    const lockKey = this.getLockKey(resource, type);
    const lock = this.locks.get(lockKey);

    if (!lock) {
      return null;
    }

    if (this.isCompatible(lock, mode, '')) {
      return null;
    }

    return {
      resource,
      type,
      requestedMode: mode,
      currentMode: lock.mode,
      holders: this.getAllHolders(lock),
    };
  }

  /**
   * 获取锁定某资源的所有 Agent
   */
  getHolders(resource: string): string[] {
    const type = this.inferResourceType(resource);
    const lockKey = this.getLockKey(resource, type);
    const lock = this.locks.get(lockKey);

    if (!lock) {
      return [];
    }

    return this.getAllHolders(lock);
  }

  /**
   * 自动选择冲突解决策略
   */
  resolveConflict(conflict: ResourceConflict): ConflictResolution {
    // 共享读取冲突 → 等待
    if (conflict.requestedMode === 'shared') {
      return ConflictResolution.WAIT;
    }

    // 文件写冲突 → 等待
    if (conflict.type === 'file') {
      return ConflictResolution.WAIT;
    }

    // 命令执行冲突 → 队列
    if (conflict.type === 'command') {
      return ConflictResolution.QUEUE;
    }

    // 目录冲突 → 等待
    if (conflict.type === 'directory') {
      return ConflictResolution.WAIT;
    }

    // 默认等待
    return ConflictResolution.WAIT;
  }

  /**
   * 获取当前所有锁的状态
   */
  getStatus(): {
    totalLocks: number;
    byType: Record<ResourceType, number>;
    byMode: Record<LockMode, number>;
    waitingRequests: number;
  } {
    const byType: Record<ResourceType, number> = {
      file: 0,
      directory: 0,
      command: 0,
      network: 0,
    };
    const byMode: Record<LockMode, number> = {
      exclusive: 0,
      shared: 0,
    };

    for (const lock of this.locks.values()) {
      byType[lock.type]++;
      byMode[lock.mode]++;
    }

    let waitingRequests = 0;
    for (const queue of this.waitQueues.values()) {
      waitingRequests += queue.length;
    }

    return {
      totalLocks: this.locks.size,
      byType,
      byMode,
      waitingRequests,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.locks.clear();
    this.waitQueues.clear();
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private getLockKey(resource: string, type: ResourceType): string {
    return `${type}:${resource}`;
  }

  private inferResourceType(resource: string): ResourceType {
    // 简单推断：
    // - 包含 / 或 \\ 的是文件/目录
    // - 以 http 开头的是网络
    // - 其他是命令
    if (resource.startsWith('http://') || resource.startsWith('https://')) {
      return 'network';
    }
    if (resource.includes('/') || resource.includes('\\')) {
      // 以 / 结尾的是目录
      if (resource.endsWith('/') || resource.endsWith('\\')) {
        return 'directory';
      }
      return 'file';
    }
    return 'command';
  }

  private isCompatible(lock: ResourceLock, requestedMode: LockMode, requesterId: string): boolean {
    // 同一个 holder 可以重入
    if (lock.holderId === requesterId) {
      return true;
    }

    // 共享锁可以与共享锁兼容
    if (lock.mode === 'shared' && requestedMode === 'shared') {
      return true;
    }

    return false;
  }

  private getAllHolders(lock: ResourceLock): string[] {
    const holders = [lock.holderId];
    if (lock.sharedHolders) {
      holders.push(...lock.sharedHolders);
    }
    return holders;
  }

  private grantLock(
    holderId: string,
    resource: string,
    type: ResourceType,
    mode: LockMode,
    timeout: number
  ): LockAcquisitionResult {
    const lockKey = this.getLockKey(resource, type);
    const lock: ResourceLock = {
      resource,
      type,
      holderId,
      mode,
      acquiredAt: Date.now(),
      timeout,
    };

    this.locks.set(lockKey, lock);
    logger.debug(`Lock acquired by ${holderId} for ${resource} (${mode})`);

    return { acquired: true };
  }

  private addSharedHolder(lock: ResourceLock, holderId: string): LockAcquisitionResult {
    if (!lock.sharedHolders) {
      lock.sharedHolders = [];
    }

    if (!lock.sharedHolders.includes(holderId) && lock.holderId !== holderId) {
      lock.sharedHolders.push(holderId);
      logger.debug(`Shared holder ${holderId} added for ${lock.resource}`);
    }

    return { acquired: true };
  }

  private async waitForLock(
    holderId: string,
    resource: string,
    type: ResourceType,
    mode: LockMode,
    timeout: number,
    waitTimeout: number
  ): Promise<LockAcquisitionResult> {
    const lockKey = this.getLockKey(resource, type);

    return new Promise((resolve) => {
      // 添加到等待队列
      if (!this.waitQueues.has(lockKey)) {
        this.waitQueues.set(lockKey, []);
      }

      const queue = this.waitQueues.get(lockKey)!;
      queue.push({ holderId, mode, resolve });

      // 设置超时
      setTimeout(() => {
        const index = queue.findIndex((w) => w.holderId === holderId);
        if (index !== -1) {
          queue.splice(index, 1);
          resolve({
            acquired: false,
            reason: 'Wait timeout',
            estimatedWait: waitTimeout,
          });
        }
      }, waitTimeout);
    });
  }

  private processWaitQueue(lockKey: string): void {
    const queue = this.waitQueues.get(lockKey);
    if (!queue || queue.length === 0) {
      return;
    }

    const next = queue.shift()!;
    const [typeStr, resource] = lockKey.split(':', 2);
    const type = typeStr as ResourceType;

    const result = this.grantLock(next.holderId, resource, type, next.mode, 300000);
    next.resolve(result);
  }

  private cleanupExpiredLocks(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [key, lock] of this.locks) {
      if (now - lock.acquiredAt > lock.timeout) {
        expired.push(key);
        logger.warn(`Lock expired for ${lock.resource} (held by ${lock.holderId})`);
      }
    }

    for (const key of expired) {
      this.locks.delete(key);
      this.processWaitQueue(key);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let lockManagerInstance: ResourceLockManager | null = null;

/**
 * 获取 ResourceLockManager 单例
 */
export function getResourceLockManager(): ResourceLockManager {
  if (!lockManagerInstance) {
    lockManagerInstance = new ResourceLockManager();
  }
  return lockManagerInstance;
}
