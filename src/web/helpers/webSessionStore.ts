import type { Message, ModelConfig } from '../../shared/contract';
import type { DatabaseService } from '../../host/services/core/databaseService';
import { extractArtifacts } from '../../host/agent/artifactExtractor';
import type { AgentSessionManagerLike } from '../routes/agentRouteTypes';
import type { WebRouteLogger } from '../routes/routeTypes';
import {
  type CachedContentPart,
  type CachedMessage,
  type CachedToolCall,
  dbAvailable,
  inMemorySessions,
  seedSessionMessagesFromPersisted,
  SESSION_CACHE_MAX,
  sessionMessages,
} from './sessionCache';

interface WebSessionStoreDeps {
  tryGetSessionManager: () => Promise<AgentSessionManagerLike | null>;
  logger: WebRouteLogger;
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
  sessionManager: AgentSessionManagerLike | null,
  db: DatabaseService,
  sessionId: string,
  message: Message,
): Promise<void> {
  if (sessionManager?.addMessageToSession) {
    await sessionManager.addMessageToSession(sessionId, message);
    return;
  }

  try {
    db.addMessage(sessionId, message);
  } catch (error) {
    if (!isDuplicateMessageError(error)) {
      throw error;
    }
    db.updateMessage(message.id, message);
  }
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
  const cached = [...(sessionMessages.get(sessionId) || []), userMessage];
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
  sessionMessages.set(sessionId, cached);

  if (sessionMessages.size > SESSION_CACHE_MAX) {
    const oldestKey = sessionMessages.keys().next().value;
    if (oldestKey) sessionMessages.delete(oldestKey);
  }
}

export function createWebSessionStore(deps: WebSessionStoreDeps) {
  // 兜底判定只认「终轮」assistant 是否落库：早轮已落库不能抑制兜底（终轮落库失败时
  // 内容+metadata 会静默丢失）。兜底写的是本 run 合并全文，早轮已在库时触发会有部分
  // 内容重复——丢终轮结论比重复早轮片段更不可接受，取舍偏向保内容。
  async function hasPersistedFinalLoopAssistantMessage(
    sessionId: string,
    finalMessageId: string | undefined,
    sessionManager: AgentSessionManagerLike | null,
    db: DatabaseService,
  ): Promise<boolean> {
    if (!finalMessageId) {
      return false;
    }

    try {
      const persisted = sessionManager?.getMessages
        ? await sessionManager.getMessages(sessionId)
        : db.getMessages(sessionId);

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

  return {
    async loadSessionHistoryForRun(sessionId: string): Promise<CachedMessage[]> {
      const cached = sessionMessages.get(sessionId);
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
        const sm = await deps.tryGetSessionManager();
        const db = await ensureDbSession(
          deps.getDatabase,
          input.sessionId,
          input.title,
          input.modelConfig,
        );
        await persistMessageToDb(sm, db, input.sessionId, input.message);
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

      const assistantMsgId = `msg-${Date.now()}-a`;
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

      // ── 更新内存会话元数据 ──
      {
        const existing = inMemorySessions.get(sessionId);
        if (existing) {
          existing.updatedAt = Date.now();
          existing.messageCount = (sessionMessages.get(sessionId) || []).length;
          if (historyLength === 0) existing.title = title;
        } else {
          inMemorySessions.set(sessionId, {
            id: sessionId,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: (sessionMessages.get(sessionId) || []).length,
          });
        }
      }

      // ── 持久化到数据库（优先走 SM 保持缓存一致）──
      if (dbAvailable) {
        let sm: AgentSessionManagerLike | null = null;
        try {
          const db = await ensureDbSession(deps.getDatabase, sessionId, title, modelConfig);
          sm = await deps.tryGetSessionManager();
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
            } as Message);
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
            } as Message);
          }

          // 更新会话标题/时间戳
          if (historyLength === 0) {
            db.updateSession(sessionId, { title, updatedAt: Date.now() });
          } else {
            db.updateSession(sessionId, { updatedAt: Date.now() });
          }
        } catch (dbErr) {
          deps.logger.warn('Failed to persist messages to DB:', (dbErr as Error).message);
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
