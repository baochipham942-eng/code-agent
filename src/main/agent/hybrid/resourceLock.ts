// ============================================================================
// 资源锁管理器 - Agent 间资源互斥
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentSwarm');

/**
 * 资源锁管理器
 */
export class ResourceLockManager {
  private locks: Map<string, { owner: string; timestamp: number }> = new Map();

  /**
   * 尝试获取锁
   */
  acquire(resource: string, agentId: string, timeout = 30000): boolean {
    const existing = this.locks.get(resource);

    // 检查是否已被锁定
    if (existing) {
      // 检查是否超时
      if (Date.now() - existing.timestamp > timeout) {
        logger.warn('Lock timeout, forcing release', { resource, previousOwner: existing.owner });
        this.locks.delete(resource);
      } else {
        return false;
      }
    }

    this.locks.set(resource, { owner: agentId, timestamp: Date.now() });
    return true;
  }

  /**
   * 释放锁
   */
  release(resource: string, agentId: string): boolean {
    const lock = this.locks.get(resource);
    if (lock && lock.owner === agentId) {
      this.locks.delete(resource);
      return true;
    }
    return false;
  }

  /**
   * 释放 Agent 的所有锁
   */
  releaseAll(agentId: string): void {
    for (const [resource, lock] of this.locks) {
      if (lock.owner === agentId) {
        this.locks.delete(resource);
      }
    }
  }

  /**
   * 重置所有锁
   */
  reset(): void {
    this.locks.clear();
  }
}
