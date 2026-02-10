// ============================================================================
// Session Recovery Service - Cross-session task recovery
// On SessionStart, queries the previous session in the same working directory
// and generates a recovery summary if that session appears incomplete.
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionRecovery');

/** 上一次会话的摘要 */
interface SessionSummary {
  sessionId: string;
  title: string;
  userRequest: string;
  toolsUsed: string[];
  modifiedFiles: string[];
  messageCount: number;
  lastActivityAgo: number; // ms since last activity
  appearsComplete: boolean;
}

/**
 * SessionRecoveryService — 跨会话任务恢复
 *
 * 核心理念：会话独立，上次中断的任务在新会话中没有任何上下文。
 * 通过查询同目录的上一个会话，生成恢复摘要注入到新会话。
 */
export class SessionRecoveryService {
  private static instance: SessionRecoveryService;

  /**
   * 检查是否有可恢复的前序会话
   * @returns 恢复摘要字符串，或 null（无需恢复）
   */
  async checkPreviousSession(
    currentSessionId: string,
    workingDirectory: string
  ): Promise<string | null> {
    try {
      const summary = await this.getLastSessionSummary(currentSessionId, workingDirectory);
      if (!summary) return null;
      if (summary.appearsComplete) return null;

      return this.buildRecoverySummary(summary);
    } catch (error) {
      logger.warn('[SessionRecovery] Failed to check previous session', error);
      return null;
    }
  }

  /**
   * 查最近 10 个会话，找同 workingDirectory 的上一个（跳过 >24h 的）
   */
  private async getLastSessionSummary(
    currentSessionId: string,
    workingDirectory: string
  ): Promise<SessionSummary | null> {
    try {
      // 延迟导入，因为 CLI 模式下可能没有 Electron DB
      const { getDatabase } = await import('../services/core');
      const db = getDatabase();

      const sessions = db.listSessions(10);
      const now = Date.now();
      const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

      for (const session of sessions) {
        // 跳过当前会话
        if (session.id === currentSessionId) continue;

        // 跳过不同目录的会话
        if (session.workingDirectory !== workingDirectory) continue;

        // 跳过 >24h 的旧会话
        const age = now - session.updatedAt;
        if (age > MAX_AGE_MS) continue;

        // 找到了！加载消息来判断完成状态
        const messages = db.getMessages(session.id);
        if (messages.length === 0) continue;

        // 提取用户请求（第一条 user 消息）
        const firstUserMsg = messages.find(m => m.role === 'user');
        const userRequest = firstUserMsg?.content
          ? (typeof firstUserMsg.content === 'string'
            ? firstUserMsg.content.substring(0, 200)
            : JSON.stringify(firstUserMsg.content).substring(0, 200))
          : '(unknown)';

        // 提取使用的工具
        const toolsUsed = new Set<string>();
        const modifiedFiles = new Set<string>();
        for (const msg of messages) {
          if (msg.toolCalls) {
            for (const tc of msg.toolCalls) {
              toolsUsed.add(tc.name);
              if ((tc.name === 'edit_file' || tc.name === 'write_file') && tc.arguments) {
                const fp = (tc.arguments as Record<string, unknown>).file_path as string;
                if (fp) modifiedFiles.add(fp);
              }
            }
          }
        }

        // 判断是否完成：最后一条消息是 assistant 且无 toolCalls 通常表示完成
        const lastMsg = messages[messages.length - 1];
        const appearsComplete = lastMsg?.role === 'assistant' && !lastMsg.toolCalls;

        return {
          sessionId: session.id,
          title: session.title,
          userRequest,
          toolsUsed: Array.from(toolsUsed),
          modifiedFiles: Array.from(modifiedFiles),
          messageCount: messages.length,
          lastActivityAgo: age,
          appearsComplete,
        };
      }

      return null;
    } catch (error) {
      logger.debug('[SessionRecovery] Database not available', error);
      return null;
    }
  }

  /**
   * 构建恢复摘要注入文本
   */
  private buildRecoverySummary(summary: SessionSummary): string {
    const agoMinutes = Math.round(summary.lastActivityAgo / 60000);
    const agoText = agoMinutes < 60
      ? `${agoMinutes} 分钟前`
      : `${Math.round(agoMinutes / 60)} 小时前`;

    const filesText = summary.modifiedFiles.length > 0
      ? `修改了: ${summary.modifiedFiles.slice(0, 5).join(', ')}${summary.modifiedFiles.length > 5 ? ` 等 ${summary.modifiedFiles.length} 个文件` : ''}`
      : '未修改文件';

    return (
      `<session-recovery>\n` +
      `上次会话 (${summary.title || summary.sessionId.substring(0, 8)}) 在 ${agoText} 执行了:\n` +
      `目标: ${summary.userRequest}\n` +
      `${filesText}\n` +
      `工具: ${summary.toolsUsed.slice(0, 8).join(', ')}\n` +
      `该会话可能未完成（${summary.messageCount} 条消息）。\n` +
      `如果用户的请求与上次相关，请考虑延续之前的工作。\n` +
      `</session-recovery>`
    );
  }

  static getInstance(): SessionRecoveryService {
    if (!SessionRecoveryService.instance) {
      SessionRecoveryService.instance = new SessionRecoveryService();
    }
    return SessionRecoveryService.instance;
  }
}

export function getSessionRecoveryService(): SessionRecoveryService {
  return SessionRecoveryService.getInstance();
}
