// ============================================================================
// Diff Tracker - 变更追踪与 Visual Diff
// ============================================================================
//
// 每次文件修改产生结构化 diff，持久化存储，可查询。
// 复用 diff 库（已在 dependencies）计算 unified diff。

import * as Diff from 'diff';
import { createLogger } from '../infra/logger';
import type { FileDiff, DiffSummary } from '../../../shared/types/diff';

const logger = createLogger('DiffTracker');

// 内存缓存：sessionId -> FileDiff[]
const sessionDiffs = new Map<string, FileDiff[]>();

// 每个 session 最大保存 diff 数
const MAX_DIFFS_PER_SESSION = 200;

export class DiffTracker {
  /**
   * 计算 diff 并存储
   */
  computeAndStore(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    filePath: string,
    before: string | null,
    after: string | null
  ): FileDiff {
    const unifiedDiff = Diff.createPatch(
      filePath,
      before || '',
      after || '',
      'before',
      'after'
    );

    // 统计增删行数
    const stats = { additions: 0, deletions: 0 };
    const lines = unifiedDiff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        stats.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        stats.deletions++;
      }
    }

    const diff: FileDiff = {
      id: `diff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      messageId,
      toolCallId,
      filePath,
      before,
      after,
      unifiedDiff,
      stats,
      timestamp: Date.now(),
    };

    // 存储
    if (!sessionDiffs.has(sessionId)) {
      sessionDiffs.set(sessionId, []);
    }
    const diffs = sessionDiffs.get(sessionId)!;
    diffs.push(diff);

    // 清理旧条目（FIFO）
    if (diffs.length > MAX_DIFFS_PER_SESSION) {
      diffs.splice(0, diffs.length - MAX_DIFFS_PER_SESSION);
    }

    logger.debug('Diff computed', {
      id: diff.id,
      filePath,
      additions: stats.additions,
      deletions: stats.deletions,
    });

    return diff;
  }

  /**
   * 获取 session 的所有 diff
   */
  getDiffsForSession(sessionId: string): FileDiff[] {
    return sessionDiffs.get(sessionId) || [];
  }

  /**
   * 获取指定消息的 diff
   */
  getDiffsForMessage(sessionId: string, messageId: string): FileDiff[] {
    const diffs = sessionDiffs.get(sessionId) || [];
    return diffs.filter(d => d.messageId === messageId);
  }

  /**
   * 获取指定文件的 diff 历史
   */
  getDiffsForFile(sessionId: string, filePath: string): FileDiff[] {
    const diffs = sessionDiffs.get(sessionId) || [];
    return diffs.filter(d => d.filePath === filePath);
  }

  /**
   * 获取会话 diff 摘要
   */
  getSummary(sessionId: string): DiffSummary {
    const diffs = sessionDiffs.get(sessionId) || [];
    const uniqueFiles = new Set(diffs.map(d => d.filePath));

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const d of diffs) {
      totalAdditions += d.stats.additions;
      totalDeletions += d.stats.deletions;
    }

    return {
      filesChanged: uniqueFiles.size,
      totalAdditions,
      totalDeletions,
    };
  }

  /**
   * 清理 session 数据
   */
  clearSession(sessionId: string): void {
    sessionDiffs.delete(sessionId);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: DiffTracker | null = null;

export function getDiffTracker(): DiffTracker {
  if (!instance) {
    instance = new DiffTracker();
  }
  return instance;
}

export function resetDiffTracker(): void {
  instance = null;
  sessionDiffs.clear();
}
