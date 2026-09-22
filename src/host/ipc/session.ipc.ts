// ============================================================================
// Session IPC Handlers - session:* 通道
// ============================================================================
//
// 域通道（IPC_DOMAINS.SESSION）自 RQ-183 刀 2 起走单源路由表
// （src/host/ipc/domainRoutes/sessionRoutes.ts）：46 个 action 的校验/handler 表
// 与两侧上下文差异全部沉入 SessionCommandContext，本文件只保留装配与 legacy 通道。
// 生产唯一装配点是 setupAllIpcHandlers（全仓只有 webServer 一个调用点）。

import type { IpcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { Message } from '../../shared/contract';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type {
  CrossSessionSearchOptions,
  CrossSessionSearchResults,
  CrossSessionSearchResultItem,
  SessionReviewItemsRequest,
} from '../../shared/ipc/types';
import {
  listAdminReviewQueueItems,
  type AdminReviewQueueItem,
} from '../../shared/contract/productClosure';
import { getDefaultSearchManager, type SessionSearchFtsSource } from '../session/search';
import {
  getDefaultCache,
  type CachedMessage,
} from '../session/localCache';
import { SESSION_SEARCH } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import { assertAdminAccess } from './adminGuard';
import { getArtifactIssueRepository } from '../services/core/repositories/ArtifactIssueRepository';
import { installDomainRoutes } from './domainRoutes/registry';
import {
  createDesktopSessionContext,
  defineSessionRoutes,
  sessionRoutes,
  type SessionCommandContext,
} from './domainRoutes/sessionRoutes';

const logger = createLogger('SessionIPC');

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Session 相关 IPC handlers。
 *
 * 域通道经 installDomainRoutes 装配单源表：webServer 注入 web context 时装 web
 * 形态，否则装桌面形态。刀 3 起两形态共用同一套 handler（46 action 全量），
 * 差异只在未知 action 兜底文案与两侧 context。
 */
export function registerSessionHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null,
  webContext?: SessionCommandContext,
): void {
  const requireAppService = (): AgentApplicationService => {
    const svc = getAppService();
    if (!svc) throw new Error('Services not initialized');
    return svc;
  };

  // ========== Domain Handler（单源路由表，RQ-183 刀 2） ==========
  installDomainRoutes(
    ipcMain,
    webContext ? defineSessionRoutes('web') : sessionRoutes,
    webContext ?? createDesktopSessionContext(getAppService),
  );

  // ========== Legacy Handlers (Deprecated，方案 2.5 不收) ==========

  // Load older messages (pagination)
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_OLDER_MESSAGES, async (_, payload: { sessionId: string; beforeTimestamp: number; limit?: number }) => {
    return requireAppService().loadOlderMessages(payload.sessionId, payload.beforeTimestamp, payload.limit ?? 30);
  });

  // Cross-session search
  ipcMain.handle(IPC_CHANNELS.SESSION_SEARCH, async (_, payload: { query: string; options?: CrossSessionSearchOptions }) => {
    return performCrossSessionSearch(payload.query, payload.options, requireAppService);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_REVIEW_ITEMS, async (_, payload: SessionReviewItemsRequest): Promise<Record<string, AdminReviewQueueItem[]>> => {
    assertAdminAccess('Review Queue');
    return listReviewItemsBySession(payload);
  });

  // Plan title — agent 用 ## Plan: ... 在 markdown 里声明的会话标题，UI 顶部大字号显示
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_PLAN_TITLE, async (_, sessionId: string): Promise<string | null> => {
    try {
      const db = (await import('../services/core/databaseService')).getDatabase();
      if (!db.isReady) return null;
      return db.getSessionPlanTitle(sessionId);
    } catch {
      return null;
    }
  });
}

function listReviewItemsBySession(payload: SessionReviewItemsRequest): Record<string, AdminReviewQueueItem[]> {
  const repo = getArtifactIssueRepository();
  if (!repo) {
    return {};
  }

  const requestedSessionIds = Array.from(new Set(
    (payload.sessionIds ?? [])
      .map((sessionId) => sessionId.trim())
      .filter(Boolean),
  ));
  if (requestedSessionIds.length === 0) {
    return {};
  }

  const requestedSet = new Set(requestedSessionIds);
  const limitPerSession = Math.max(1, Math.min(payload.limitPerSession ?? 3, 10));
  const grouped: Record<string, AdminReviewQueueItem[]> = {};
  for (const sessionId of requestedSet) {
    const items = listAdminReviewQueueItems(
      repo.listIssues({ sessionId, limit: Math.max(limitPerSession * 4, 10) }),
      { includeReviewed: payload.includeReviewed },
    ).slice(0, limitPerSession);
    if (items.length > 0) {
      grouped[sessionId] = items;
    }
  }
  return grouped;
}

// ----------------------------------------------------------------------------
// Helper: Cross-session search
// ----------------------------------------------------------------------------

function isCacheableMessage(
  message: Message,
): message is Message & { role: CachedMessage['role'] } {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'system';
}

async function hydrateCrossSessionSearchCache(sessionIds: string[]): Promise<void> {
  const cache = getDefaultCache();
  const missingSessionIds = Array.from(new Set(sessionIds))
    .filter((sessionId) => !cache.getSession(sessionId));

  if (missingSessionIds.length === 0) {
    return;
  }

  let database: ReturnType<typeof import('../services/core/databaseService').getDatabase>;
  try {
    const { getDatabase } = await import('../services/core/databaseService');
    database = getDatabase();
  } catch (error) {
    logger.warn('Failed to access database for cross-session search hydration', {
      sessionIds: missingSessionIds,
      error,
    });
    return;
  }

  if (!database.isReady) {
    logger.warn('Skipping cross-session search hydration because database is not ready', {
      sessionIds: missingSessionIds,
    });
    return;
  }

  for (const sessionId of missingSessionIds) {
    try {
      const messages = database.getMessages(sessionId, SESSION_SEARCH.HYDRATE_MESSAGE_LIMIT);
      const cachedMessages: CachedMessage[] = messages
        .filter(isCacheableMessage)
        .map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          metadata: message.metadata as Record<string, unknown> | undefined,
          toolCalls: message.toolCalls,
          toolResults: message.toolResults,
        }));
      const startedAt = cachedMessages[0]?.timestamp ?? Date.now();

      cache.setSession({
        sessionId,
        messages: cachedMessages,
        startedAt,
        lastActivityAt: cachedMessages[cachedMessages.length - 1]?.timestamp ?? startedAt,
        totalTokens: 0,
      });
    } catch (error) {
      logger.warn('Failed to hydrate session for cross-session search', {
        sessionId,
        error,
      });
    }
  }
}

/**
 * 惰性解析 FTS 数据源（与 hydrateCrossSessionSearchCache 同款动态 import，
 * 避免 IPC 模块加载期引入 databaseService）。DB 未就绪 / 不可用时返回
 * undefined，搜索回落内存 LRU 路径。
 */
async function resolveSessionSearchFtsSource(): Promise<SessionSearchFtsSource | undefined> {
  try {
    const { getDatabase } = await import('../services/core/databaseService');
    const database = getDatabase();
    return database.isReady ? database : undefined;
  } catch (error) {
    logger.warn('FTS source unavailable for cross-session search, falling back to in-memory cache', {
      error,
    });
    return undefined;
  }
}

export async function performCrossSessionSearch(
  query: string,
  options: CrossSessionSearchOptions | undefined,
  getAppService: () => AgentApplicationService
): Promise<CrossSessionSearchResults> {
  if (!query.trim()) {
    return { query, totalMatches: 0, sessionsWithMatches: 0, results: [], searchTime: 0, truncated: false };
  }

  if (options?.sessionIds && options.sessionIds.length > 0) {
    await hydrateCrossSessionSearchCache(options.sessionIds);
  }

  // FTS 数据源（全库检索）；DB 不可用时回落内存 LRU 搜索（原行为）
  const ftsSource = await resolveSessionSearchFtsSource();

  const searchManager = getDefaultSearchManager();
  const searchResults = searchManager.search(query, {
    limit: options?.limit ?? 30,
    sessionIds: options?.sessionIds,
    role: options?.role,
    caseSensitive: options?.caseSensitive ?? false,
    sortBy: 'relevance',
    sortOrder: 'desc',
    includeContext: 80,
  }, ftsSource);

  // Build session title map from app service
  const sessionTitleMap: Map<string, string> = new Map();
  try {
    const sessions = await getAppService().listSessions({ includeArchived: true });
    for (const s of sessions) {
      sessionTitleMap.set(s.id, s.title);
    }
  } catch {
    // If listing sessions fails, proceed without titles
  }

  const results: CrossSessionSearchResultItem[] = searchResults.results.map((r) => ({
    sessionId: r.sessionId,
    sessionTitle: sessionTitleMap.get(r.sessionId),
    messageId: r.message.id,
    messageIndex: r.messageIndex,
    turnNumber: r.turnNumber,
    role: r.message.role,
    timestamp: r.message.timestamp,
    matchOffset: r.matches[0]?.start,
    relevance: r.relevance,
    snippet: r.snippet,
    matchCount: r.matches.length,
  }));

  return {
    query: searchResults.query,
    totalMatches: searchResults.totalMatches,
    sessionsWithMatches: searchResults.sessionsWithMatches,
    results,
    searchTime: searchResults.searchTime,
    truncated: searchResults.truncated,
  };
}
