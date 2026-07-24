// ============================================================================
// Session IPC Handlers - session:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { Message } from '../../shared/contract';
import type { AgentApplicationService, SwitchModelParams } from '../../shared/contract/appService';
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
import { getDefaultSearchManager } from '../session/search';
import {
  getDefaultCache,
  type CachedMessage,
} from '../session/localCache';
import { createLogger } from '../services/infra/logger';
import { assertAdminAccess } from './adminGuard';
import { getArtifactIssueRepository } from '../services/core/repositories/ArtifactIssueRepository';

/** Inline stub — old memoryTriggerService removed */
type SessionMemoryContext = unknown;

const logger = createLogger('SessionIPC');
const CROSS_SESSION_SEARCH_MESSAGE_LIMIT = 500;

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Session 相关 IPC handlers
 */
export function registerSessionHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null
): void {
  const requireAppService = (): AgentApplicationService => {
    const svc = getAppService();
    if (!svc) throw new Error('Services not initialized');
    return svc;
  };

  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.SESSION, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'list':
          data = await requireAppService().listSessions(payload as { includeArchived?: boolean } | undefined);
          break;
        case 'create':
          data = await requireAppService().createSession(payload as import('../../shared/contract/appService').CreateSessionConfig);
          break;
        case 'load':
          data = await requireAppService().loadSession((payload as { sessionId: string }).sessionId);
          break;
        case 'delete':
          await requireAppService().deleteSession((payload as { sessionId: string }).sessionId);
          data = null;
          break;
        case 'getMessages':
          data = await requireAppService().getMessages((payload as { sessionId: string }).sessionId);
          break;
        case 'getSessionTasks':
          data = await requireAppService().getSessionTasks((payload as { sessionId: string }).sessionId);
          break;
        case 'rewindToPrompt': {
          const p = payload as { sessionId: string; userMessageId: string };
          data = await requireAppService().rewindToPrompt(p);
          break;
        }
        case 'export':
          data = await requireAppService().exportSession((payload as { sessionId: string }).sessionId);
          break;
        case 'exportMarkdown':
          data = await requireAppService().exportSessionMarkdown((payload as { sessionId: string }).sessionId);
          break;
        case 'exportDiagnostics':
          data = await requireAppService().exportSessionDiagnostics((payload as { sessionId: string }).sessionId);
          break;
        case 'import':
          data = await requireAppService().importSession((payload as { data: unknown }).data);
          break;
        case 'getMemoryContext': {
          const p = payload as { sessionId: string; workingDirectory?: string; query?: string };
          data = await requireAppService().getMemoryContext(p.sessionId, p.workingDirectory, p.query) as SessionMemoryContext;
          break;
        }
        case 'update': {
          const p = payload as { sessionId: string; updates: Partial<import('../../shared/contract/session').Session> };
          await requireAppService().updateSession(p.sessionId, p.updates);
          data = null;
          break;
        }
        case 'archive':
          data = await requireAppService().archiveSession((payload as { sessionId: string }).sessionId);
          break;
        case 'unarchive':
          data = await requireAppService().unarchiveSession((payload as { sessionId: string }).sessionId);
          break;
        case 'switchModel': {
          const p = payload as SwitchModelParams;
          const result = await requireAppService().switchModel(p);
          data = { provider: p.provider, model: p.model, persisted: result.persisted };
          break;
        }
        case 'getModelOverride': {
          const { sessionId } = payload as { sessionId: string };
          data = requireAppService().getModelOverride(sessionId);
          break;
        }
        case 'clearModelOverride': {
          const { sessionId } = payload as { sessionId: string };
          const result = await requireAppService().clearModelOverride(sessionId);
          data = { persisted: result.persisted };
          break;
        }
        case 'search': {
          const p = payload as { query: string; options?: CrossSessionSearchOptions };
          data = await performCrossSessionSearch(p.query, p.options, requireAppService);
          break;
        }
        default:
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: `Unknown action: ${action}`,
            },
          };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

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

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_TASKS, async (_, sessionId: string) => {
    return requireAppService().getSessionTasks(sessionId);
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
      const messages = database.getMessages(sessionId, CROSS_SESSION_SEARCH_MESSAGE_LIMIT);
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

  const searchManager = getDefaultSearchManager();
  const searchResults = searchManager.search(query, {
    limit: options?.limit ?? 30,
    sessionIds: options?.sessionIds,
    role: options?.role,
    caseSensitive: options?.caseSensitive ?? false,
    sortBy: 'relevance',
    sortOrder: 'desc',
    includeContext: 80,
  });

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
