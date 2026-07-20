import type { Message, ModelConfig, Session } from '../../shared/contract';
import type { DatabaseService } from '../../host/services/core/databaseService';
import { extractArtifacts } from '../../host/agent/artifactExtractor';
import type { SessionCreateOptions } from '../../cli/session';
import { generateMessageId } from '../../shared/utils/id';
import type { WebRouteLogger } from '../routes/routeTypes';
import {
  type CachedContentPart,
  type CachedMessage,
  type CachedToolCall,
  dbAvailable,
  type InMemorySession,
  toCachedSessionMessages,
} from './sessionCache';

const SESSION_CACHE_MAX = 50;
const sessionMessages = new Map<string, CachedMessage[]>();
const inMemorySessions = new Map<string, InMemorySession>();

function enforceSessionCacheLimit(): void {
  if (sessionMessages.size <= SESSION_CACHE_MAX) return;
  const oldestKey = sessionMessages.keys().next().value;
  if (oldestKey) sessionMessages.delete(oldestKey);
}

export function getSessionMessagesProjection(sessionId: string): CachedMessage[] | undefined {
  return sessionMessages.get(sessionId);
}

export function replaceSessionMessagesProjection(
  sessionId: string,
  messages: CachedMessage[],
): void {
  sessionMessages.set(sessionId, messages);
  enforceSessionCacheLimit();
}

export function seedSessionMessagesFromPersisted(
  sessionId: string,
  messages: Message[],
): CachedMessage[] {
  const cached = toCachedSessionMessages(messages);
  if (cached.length > 0) {
    replaceSessionMessagesProjection(sessionId, cached);
  }
  return cached;
}

export function getSessionMessageCount(sessionId: string): number {
  return sessionMessages.get(sessionId)?.length ?? 0;
}

export function listSessionProjections(includeArchived: boolean): InMemorySession[] {
  return [...inMemorySessions.values()]
    .filter((session) => includeArchived || !session.isArchived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSessionProjection(sessionId: string): InMemorySession | undefined {
  return inMemorySessions.get(sessionId);
}

export function upsertSessionProjection(session: InMemorySession): void {
  inMemorySessions.set(session.id, session);
}

export function setSessionArchivedProjection(
  sessionId: string,
  isArchived: boolean,
): InMemorySession | undefined {
  const session = inMemorySessions.get(sessionId);
  if (!session) return undefined;
  session.isArchived = isArchived;
  session.archivedAt = isArchived ? Date.now() : undefined;
  return session;
}

export function deleteSessionProjection(sessionId: string): void {
  inMemorySessions.delete(sessionId);
  sessionMessages.delete(sessionId);
}

export function clearAllSessionProjections(): void {
  inMemorySessions.clear();
  sessionMessages.clear();
}

// 测试只通过门面搭建和观察投影现场；底层 Map 仍只归 WebSessionStore 所有。
export const sessionMessagesProjection = {
  get: getSessionMessagesProjection,
  set(sessionId: string, messages: CachedMessage[]) {
    replaceSessionMessagesProjection(sessionId, messages);
    return sessionMessagesProjection;
  },
  has: (sessionId: string) => sessionMessages.has(sessionId),
  delete: (sessionId: string) => sessionMessages.delete(sessionId),
  clear: () => sessionMessages.clear(),
  get size() {
    return sessionMessages.size;
  },
};

export const inMemorySessionsProjection = {
  get: getSessionProjection,
  set(sessionId: string, session: InMemorySession) {
    inMemorySessions.set(sessionId, session);
    return inMemorySessionsProjection;
  },
  has: (sessionId: string) => inMemorySessions.has(sessionId),
  delete: (sessionId: string) => inMemorySessions.delete(sessionId),
  clear: () => inMemorySessions.clear(),
  get size() {
    return inMemorySessions.size;
  },
};

interface WebCLISessionManagerLike {
  getMessages?(sessionId: string, limit?: number): Promise<Message[]>;
  getSession?(sessionId: string, messageLimit?: number): Promise<{ title?: string } | null>;
  updateSession?(sessionId: string, updates: Partial<Session>): Promise<void> | void;
  addMessageToSession?(
    sessionId: string,
    message: Message,
    options?: SessionCreateOptions & { setCurrent?: boolean },
  ): Promise<void>;
  /** 后端能否真正持久化；缺省视为可持久化（向后兼容） */
  isPersistent?(): Promise<boolean>;
}

interface InfraSessionCacheInvalidator {
  invalidateSessionCache?(sessionId: string): void;
}

interface WebSessionStoreDeps {
  // webServer 生产注入的是 src/cli/bootstrap.getSessionManager() 返回的共享单例。
  tryGetSessionManager: () => Promise<WebCLISessionManagerLike | null>;
  tryGetInfraSessionManager?: () => Promise<InfraSessionCacheInvalidator | null>;
  logger: WebRouteLogger;
  // 仅保留给 CLI SM 不可用时的既有兼容降级；生产正常路径不经过 core writer。
  getDatabase: () => DatabaseService | Promise<DatabaseService>;
}

interface PrePersistUserMessageInput {
  sessionId: string;
  title: string;
  modelConfig: Pick<ModelConfig, 'provider' | 'model'>;
  message: Message;
}

interface CommitTurnInput {
  sessionId: string;
  title: string;
  modelConfig: Pick<ModelConfig, 'provider' | 'model'>;
  historyLength: number;
  userMessagePrePersistedDb: boolean;
  userMessage: CachedMessage & { role: 'user' };
  turn: {
    assistantText: string;
    assistantThinking: string;
    assistantMetadata: Message['metadata'] | undefined;
    assistantToolCalls: CachedToolCall[];
    lastLoopAssistantMessageId: string | undefined;
    contentParts: CachedContentPart[];
    runCancelled: boolean;
    hasAssistantOutput: () => boolean;
    hasInterleaving: () => boolean;
  };
}

function isDuplicateMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT');
}

async function ensureDbSession(
  getDatabase: WebSessionStoreDeps['getDatabase'],
  sessionId: string,
  title: string,
  modelConfig: Pick<ModelConfig, 'provider' | 'model'>,
): Promise<DatabaseService> {
  const db = await getDatabase();
  const existing = db.getSession(sessionId);
  if (!existing) {
    db.createSessionWithId(sessionId, {
      title,
      modelConfig,
    });
  } else {
    // renderer 端常用 '新对话' 占位 title 先创建 session 行，再发 user message。
    // 这里在 session 已存在但 title 还是默认值时，用 prompt 派生的 title 升级一次，
    // 避免 sidebar 永远停在 '新对话'。
    const isDefaultTitle =
      !existing.title ||
      existing.title === '新对话' ||
      existing.title === 'New Chat' ||
      existing.title === 'New Session' ||
      (typeof existing.title === 'string' && existing.title.startsWith('Session '));
    if (isDefaultTitle && title && title !== existing.title) {
      try {
        db.updateSession(sessionId, { title, updatedAt: Date.now() });
      } catch {
        // 升级失败不阻塞主流程，下一轮 maybeUpdateTitleForSession 还会再试
      }
    }
  }
  return db;
}

async function persistMessageToDb(
  sessionManager: WebCLISessionManagerLike | null,
  db: DatabaseService | null,
  sessionId: string,
  message: Message,
  createOptions?: SessionCreateOptions,
): Promise<void> {
  if (sessionManager?.addMessageToSession) {
    if (createOptions) {
      await sessionManager.addMessageToSession(sessionId, message, createOptions);
    } else {
      await sessionManager.addMessageToSession(sessionId, message);
    }
    return;
  }

  if (!db) {
    throw new Error('No session persistence backend available');
  }

  try {
    db.addMessage(sessionId, message);
  } catch (error) {
    if (!isDuplicateMessageError(error)) {
      throw error;
    }
    db.updateMessage(message.id, message, sessionId);
  }
}

/**
 * 只把「真正能持久化」的 session manager 交给写路径。
 *
 * 打包态 webServer 里 CLI SM 的 DB 可能永远初始化失败（better-sqlite3 依赖链缺
 * 'bindings'，2026-07-20 真机取证）——若照旧选它，消息会被静默丢弃（派发轮
 * assistant 蒸发 P0 的最内层根因）。此时视为无 SM，落回 infra 直写路径。
 * 不实现 isPersistent 的实现（测试桩/其他适配器）保持旧语义视为可持久化。
 */
async function resolvePersistentSessionManager(
  sessionManager: WebCLISessionManagerLike | null,
  logger: WebRouteLogger,
): Promise<WebCLISessionManagerLike | null> {
  if (!sessionManager) return null;
  if (!sessionManager.isPersistent) return sessionManager;
  try {
    if (await sessionManager.isPersistent()) return sessionManager;
    logger.warn('[AgentRouter] CLI session manager cannot persist; falling back to direct DB writes');
    return null;
  } catch (error) {
    logger.warn('[AgentRouter] CLI session manager persistence probe failed; falling back to direct DB writes:', error);
    return null;
  }
}

function hasCliSessionLifecycle(
  sessionManager: WebCLISessionManagerLike | null,
): sessionManager is Required<Pick<
  WebCLISessionManagerLike,
  'addMessageToSession' | 'getSession' | 'updateSession'
>> & WebCLISessionManagerLike {
  return Boolean(
    sessionManager?.addMessageToSession
    && sessionManager.getSession
    && sessionManager.updateSession,
  );
}

function isDefaultSessionTitle(title: string | undefined): boolean {
  return !title
    || title === '新对话'
    || title === 'New Chat'
    || title === 'New Session'
    || title.startsWith('Session ');
}

async function prepareCliSessionForWrite(
  sessionManager: Required<Pick<WebCLISessionManagerLike, 'getSession' | 'updateSession'>>,
  sessionId: string,
  title: string,
): Promise<boolean> {
  const existing = await sessionManager.getSession(sessionId, 1);
  if (!existing) return false;

  if (isDefaultSessionTitle(existing.title) && title && title !== existing.title) {
    try {
      await sessionManager.updateSession(sessionId, { title, updatedAt: Date.now() });
    } catch {
      // 标题升级失败不阻塞主流程，commitTurn 的元数据更新还会再试。
    }
  }
  return true;
}

function fallbackToCollectorSessionProjection(
  sessionId: string,
  userMessage: CachedMessage & { role: 'user' },
  turn: CommitTurnInput['turn'],
  assistantMsgId: string,
  assistantArtifacts: ReturnType<typeof extractArtifacts>,
): void {
  // !dbAvailable 时内存仍是主存储；DB 读回失败时也用批 2 前的 collector
  // 投影兜底，避免缓存停在半旧状态并丢掉本轮消息。
  const cached = [...(getSessionMessagesProjection(sessionId) || []), userMessage];
  if (!turn.runCancelled && turn.hasAssistantOutput()) {
    cached.push({
      id: assistantMsgId,
      role: 'assistant',
      content: turn.assistantText,
      timestamp: Date.now(),
      toolCalls: turn.assistantToolCalls.length > 0 ? turn.assistantToolCalls : undefined,
      thinking: turn.assistantThinking || undefined,
      contentParts: turn.hasInterleaving() ? turn.contentParts : undefined,
      artifacts: assistantArtifacts.length > 0 ? assistantArtifacts : undefined,
      metadata: turn.assistantMetadata,
    });
  }
  replaceSessionMessagesProjection(sessionId, cached);
}

function updateSessionMetadataProjection(
  sessionId: string,
  title: string,
  historyLength: number,
): void {
  // 这是 web 会话元数据投影：!dbAvailable 时承担主存储；dbAvailable 时仍无条件
  // 更新，但只作为数据库不可读时的降级备份视图。
  const existing = inMemorySessions.get(sessionId);
  if (existing) {
    existing.updatedAt = Date.now();
    existing.messageCount = getSessionMessageCount(sessionId);
    if (historyLength === 0) existing.title = title;
    return;
  }

  upsertSessionProjection({
    id: sessionId,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: getSessionMessageCount(sessionId),
  });
}

export function createWebSessionStore(deps: WebSessionStoreDeps) {
  // 兜底判定只认「终轮」assistant 是否落库：早轮已落库不能抑制兜底（终轮落库失败时
  // 内容+metadata 会静默丢失）。兜底写的是本 run 合并全文，早轮已在库时触发会有部分
  // 内容重复——丢终轮结论比重复早轮片段更不可接受，取舍偏向保内容。
  async function hasPersistedFinalLoopAssistantMessage(
    sessionId: string,
    finalMessageId: string | undefined,
    sessionManager: WebCLISessionManagerLike | null,
    db: DatabaseService | null,
  ): Promise<boolean> {
    if (!finalMessageId) {
      return false;
    }

    try {
      const persisted = sessionManager?.getMessages
        ? await sessionManager.getMessages(sessionId)
        : db?.getMessages(sessionId);

      return Array.isArray(persisted) && persisted.some((message) => (
        message.role === 'assistant' && message.id === finalMessageId
      ));
    } catch (error) {
      deps.logger.warn(
        `[AgentRouter] Failed to verify loop-persisted assistant messages for ${sessionId}:`,
        error,
      );
      return false;
    }
  }

  async function invalidateInfraSessionCache(sessionId: string): Promise<void> {
    if (!deps.tryGetInfraSessionManager) return;

    try {
      const infraSessionManager = await deps.tryGetInfraSessionManager();
      if (!infraSessionManager?.invalidateSessionCache) {
        deps.logger.debug?.(
          `[AgentRouter] Infra SessionManager unavailable; skipped cache invalidation for ${sessionId}`,
        );
        return;
      }
      infraSessionManager.invalidateSessionCache(sessionId);
    } catch (error) {
      deps.logger.debug?.(
        `[AgentRouter] Failed to invalidate infra SessionManager cache for ${sessionId}`,
        error,
      );
    }
  }

  return {
    async loadSessionHistoryForRun(sessionId: string): Promise<CachedMessage[]> {
      const cached = getSessionMessagesProjection(sessionId);
      if (cached?.length) {
        return cached;
      }

      try {
        const sm = await deps.tryGetSessionManager();
        if (!sm?.getMessages) {
          return [];
        }

        const persisted = await sm.getMessages(sessionId);
        if (!Array.isArray(persisted) || persisted.length === 0) {
          return [];
        }

        const restored = seedSessionMessagesFromPersisted(sessionId, persisted);
        if (restored.length === 0) {
          deps.logger.warn('[AgentRouter] Persisted session history had no user/assistant messages for run', {
            sessionId,
            persistedCount: persisted.length,
          });
        }
        return restored;
      } catch (error) {
        deps.logger.warn(`[AgentRouter] Failed to hydrate persisted history for ${sessionId}:`, error);
        return [];
      }
    },

    async prePersistUserMessage(input: PrePersistUserMessageInput): Promise<boolean> {
      if (!dbAvailable) {
        return false;
      }

      try {
        const sm = await resolvePersistentSessionManager(
          await deps.tryGetSessionManager(),
          deps.logger,
        );
        const cliSessionManager = hasCliSessionLifecycle(sm) ? sm : null;
        const sessionExists = cliSessionManager
          ? await prepareCliSessionForWrite(cliSessionManager, input.sessionId, input.title)
          : false;
        const db = cliSessionManager
          ? null
          : await ensureDbSession(
            deps.getDatabase,
            input.sessionId,
            input.title,
            input.modelConfig,
          );
        await persistMessageToDb(
          sm,
          db,
          input.sessionId,
          input.message,
          cliSessionManager && !sessionExists
            ? { title: input.title, modelConfig: input.modelConfig }
            : undefined,
        );
        return true;
      } catch (err) {
        deps.logger.warn('Pre-persist user message to DB failed (continuing run):', (err as Error).message);
        return false;
      }
    },

    async commitTurn(input: CommitTurnInput): Promise<{ assistantMsgId: string }> {
      const {
        sessionId,
        title,
        modelConfig,
        historyLength,
        userMessagePrePersistedDb,
        userMessage,
        turn,
      } = input;

      const assistantMsgId = generateMessageId();
      const assistantArtifacts = turn.assistantText ? extractArtifacts(turn.assistantText) : [];
      if (!dbAvailable) {
        fallbackToCollectorSessionProjection(
          sessionId,
          userMessage,
          turn,
          assistantMsgId,
          assistantArtifacts,
        );
      }

      updateSessionMetadataProjection(sessionId, title, historyLength);

      // ── 持久化到数据库（优先走 SM 保持缓存一致）──
      if (dbAvailable) {
        let sm: WebCLISessionManagerLike | null = null;
        let persistenceSucceeded = false;
        try {
          sm = await resolvePersistentSessionManager(
            await deps.tryGetSessionManager(),
            deps.logger,
          );
          const cliSessionManager = hasCliSessionLifecycle(sm) ? sm : null;
          const sessionExists = cliSessionManager
            ? await prepareCliSessionForWrite(cliSessionManager, sessionId, title)
            : false;
          const db = cliSessionManager
            ? null
            : await ensureDbSession(deps.getDatabase, sessionId, title, modelConfig);
          const loopPersistedAssistant = await hasPersistedFinalLoopAssistantMessage(
            sessionId,
            turn.lastLoopAssistantMessageId,
            sm,
            db,
          );

          if (!userMessagePrePersistedDb) {
            await persistMessageToDb(sm, db, sessionId, {
              id: userMessage.id,
              role: 'user',
              content: userMessage.content,
              timestamp: userMessage.timestamp,
              attachments: userMessage.attachments,
              // assistant 侧一直在落 metadata，user 侧此前漏了——ADR-040 的 locator
              // 要能回读（会话重开后仍指向用户点的那个位置），这里必须对称。
              metadata: userMessage.metadata,
            } as Message, cliSessionManager && !sessionExists
              ? { title, modelConfig }
              : undefined);
          }

          if (!turn.runCancelled && turn.hasAssistantOutput() && !loopPersistedAssistant) {
            await persistMessageToDb(sm, db, sessionId, {
              id: assistantMsgId,
              role: 'assistant',
              content: turn.assistantText,
              timestamp: Date.now(),
              toolCalls: turn.assistantToolCalls.length > 0 ? turn.assistantToolCalls : undefined,
              thinking: turn.assistantThinking || undefined,
              artifacts: assistantArtifacts.length > 0 ? assistantArtifacts : undefined,
              metadata: turn.assistantMetadata,
              contentParts: turn.hasInterleaving() ? turn.contentParts : undefined,
            } as Message);
          }

          // 更新会话标题/时间戳
          const sessionUpdates = historyLength === 0
            ? { title, updatedAt: Date.now() }
            : { updatedAt: Date.now() };
          if (cliSessionManager) {
            await cliSessionManager.updateSession(sessionId, sessionUpdates);
          } else if (db) {
            db.updateSession(sessionId, sessionUpdates);
          } else {
            throw new Error('No session metadata backend available');
          }
          persistenceSucceeded = true;
        } catch (dbErr) {
          deps.logger.warn('Failed to persist messages to DB:', (dbErr as Error).message);
        }

        if (persistenceSucceeded) {
          await invalidateInfraSessionCache(sessionId);
        }

        try {
          const projectionManager = sm ?? await deps.tryGetSessionManager();
          if (!projectionManager?.getMessages) {
            throw new Error('SessionManager.getMessages is unavailable');
          }

          const persisted = await projectionManager.getMessages(sessionId);
          sessionMessages.delete(sessionId);
          seedSessionMessagesFromPersisted(sessionId, persisted);
        } catch (error) {
          deps.logger.warn(
            `[AgentRouter] Failed to refresh session cache from persisted messages for ${sessionId}:`,
            error,
          );
          fallbackToCollectorSessionProjection(
            sessionId,
            userMessage,
            turn,
            assistantMsgId,
            assistantArtifacts,
          );
        }
      }

      return { assistantMsgId };
    },
  };
}
