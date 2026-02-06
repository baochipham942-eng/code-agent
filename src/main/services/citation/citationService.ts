// ============================================================================
// Citation Service - 会话级引用收集器
// ============================================================================

import { createLogger } from '../infra/logger';
import type { Citation } from '../../../shared/types/citation';
import { extractCitations } from './citationExtractor';

const logger = createLogger('CitationService');

// 每个 session 最多保留的引用数
const MAX_CITATIONS_PER_SESSION = 500;

export class CitationService {
  /** sessionId -> Citation[] */
  private sessionCitations = new Map<string, Citation[]>();

  /**
   * 从工具调用结果中提取并存储引用
   *
   * @returns 新提取的引用列表
   */
  extractAndStore(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    params: Record<string, unknown>,
    output: string | undefined
  ): Citation[] {
    const citations = extractCitations(toolName, toolCallId, params, output);

    if (citations.length === 0) return [];

    if (!this.sessionCitations.has(sessionId)) {
      this.sessionCitations.set(sessionId, []);
    }

    const existing = this.sessionCitations.get(sessionId)!;
    existing.push(...citations);

    // FIFO 清理
    if (existing.length > MAX_CITATIONS_PER_SESSION) {
      existing.splice(0, existing.length - MAX_CITATIONS_PER_SESSION);
    }

    logger.debug('Citations extracted', {
      sessionId,
      toolName,
      newCitations: citations.length,
      total: existing.length,
    });

    return citations;
  }

  /**
   * 获取 session 的所有引用
   */
  getCitations(sessionId: string): Citation[] {
    return this.sessionCitations.get(sessionId) || [];
  }

  /**
   * 获取指定工具调用的引用
   */
  getCitationsForToolCall(sessionId: string, toolCallId: string): Citation[] {
    const all = this.sessionCitations.get(sessionId) || [];
    return all.filter(c => c.toolCallId === toolCallId);
  }

  /**
   * 清理 session 数据
   */
  clearSession(sessionId: string): void {
    this.sessionCitations.delete(sessionId);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: CitationService | null = null;

export function getCitationService(): CitationService {
  if (!instance) {
    instance = new CitationService();
  }
  return instance;
}

export function resetCitationService(): void {
  instance = null;
}
