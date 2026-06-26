// ============================================================================
// Task Deduplication Manager - 任务去重管理器
// P1: 避免重复派发相同任务，借鉴 Anthropic 的进度追踪机制
// ============================================================================

import crypto from 'crypto';

/**
 * 已派发任务记录
 */
interface DispatchedTask {
  hash: string;           // prompt 的哈希摘要
  subagentType: string;
  promptPreview: string;  // 前 100 字符
  dispatchTime: number;
  status: 'running' | 'completed' | 'failed';
  result?: string;        // 缓存结果（限制大小）
}

/**
 * 重复检查结果
 */
interface DuplicateCheckResult {
  isDuplicate: boolean;
  cachedResult?: string;
  reason?: string;
}

/**
 * 任务去重管理器
 *
 * 借鉴 Anthropic: "maintain a JSON file with detailed feature requirements"
 * 通过哈希检测相似任务，避免重复执行
 */
class TaskDeduplicationManager {
  private dispatchedTasks = new Map<string, DispatchedTask>();
  private readonly MAX_CACHE_SIZE = 50;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
  private readonly RESULT_MAX_LENGTH = 2000; // 结果缓存最大长度

  /**
   * 计算任务哈希
   *
   * 使用 subagentType + prompt 前 200 字符计算 MD5 哈希
   */
  private computeTaskHash(subagentType: string, prompt: string): string {
    // 规范化：转小写、去除多余空白
    const normalizedPrompt = prompt
      .substring(0, 200)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const normalized = `${subagentType}:${normalizedPrompt}`;
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 12);
  }

  /**
   * 检查是否重复任务
   */
  isDuplicate(subagentType: string, prompt: string): DuplicateCheckResult {
    const hash = this.computeTaskHash(subagentType, prompt);
    const existing = this.dispatchedTasks.get(hash);

    if (!existing) {
      return { isDuplicate: false };
    }

    // 检查是否过期
    if (Date.now() - existing.dispatchTime > this.CACHE_TTL_MS) {
      this.dispatchedTasks.delete(hash);
      return { isDuplicate: false };
    }

    // 正在运行的任务
    if (existing.status === 'running') {
      return {
        isDuplicate: true,
        reason: `相同任务正在执行中 (${existing.promptPreview}...)`,
      };
    }

    // 已完成的任务，返回缓存结果
    if (existing.status === 'completed' && existing.result) {
      return {
        isDuplicate: true,
        cachedResult: existing.result,
        reason: '使用缓存结果',
      };
    }

    // 已失败的任务，允许重试
    if (existing.status === 'failed') {
      this.dispatchedTasks.delete(hash);
      return { isDuplicate: false };
    }

    return { isDuplicate: false };
  }

  /**
   * 注册新任务
   */
  registerTask(subagentType: string, prompt: string): string {
    const hash = this.computeTaskHash(subagentType, prompt);

    this.dispatchedTasks.set(hash, {
      hash,
      subagentType,
      promptPreview: prompt.substring(0, 100),
      dispatchTime: Date.now(),
      status: 'running',
    });

    // 清理旧缓存
    this.cleanup();

    return hash;
  }

  /**
   * 更新任务状态为已完成
   */
  completeTask(hash: string, result: string): void {
    const task = this.dispatchedTasks.get(hash);
    if (task) {
      task.status = 'completed';
      task.result = result.substring(0, this.RESULT_MAX_LENGTH);
    }
  }

  /**
   * 更新任务状态为失败
   */
  failTask(hash: string): void {
    const task = this.dispatchedTasks.get(hash);
    if (task) {
      task.status = 'failed';
    }
  }

  /**
   * 清理过期缓存
   */
  private cleanup(): void {
    if (this.dispatchedTasks.size <= this.MAX_CACHE_SIZE) return;

    const now = Date.now();
    const toDelete: string[] = [];

    for (const [hash, task] of this.dispatchedTasks) {
      if (now - task.dispatchTime > this.CACHE_TTL_MS) {
        toDelete.push(hash);
      }
    }

    // 如果过期删除后还是超限，删除最老的
    if (this.dispatchedTasks.size - toDelete.length > this.MAX_CACHE_SIZE) {
      const sorted = Array.from(this.dispatchedTasks.entries())
        .filter(([h]) => !toDelete.includes(h))
        .sort((a, b) => a[1].dispatchTime - b[1].dispatchTime);

      const excess = sorted.slice(0, this.dispatchedTasks.size - toDelete.length - this.MAX_CACHE_SIZE);
      toDelete.push(...excess.map(([h]) => h));
    }

    for (const hash of toDelete) {
      this.dispatchedTasks.delete(hash);
    }
  }

  /**
   * 获取当前缓存状态（用于调试）
   */
  getStats(): { size: number; running: number; completed: number; failed: number } {
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const task of this.dispatchedTasks.values()) {
      if (task.status === 'running') running++;
      else if (task.status === 'completed') completed++;
      else if (task.status === 'failed') failed++;
    }

    return {
      size: this.dispatchedTasks.size,
      running,
      completed,
      failed,
    };
  }

  /**
   * 清空所有缓存（用于测试）
   */
  clear(): void {
    this.dispatchedTasks.clear();
  }
}

// 单例导出
export const taskDeduplication = new TaskDeduplicationManager();
