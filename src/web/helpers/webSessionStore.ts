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

export function createWebSessionStore(deps: WebSessionStoreDeps) {
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

      // ── 缓存会话消息（维持多轮上下文）──
      // 无论 assistantText 是否为空都要缓存 userMsg，否则工具-only 轮次会丢失上下文
      const assistantMsgId = `msg-${Date.now()}-a`;
      const cached = [...(sessionMessages.get(sessionId) || []), userMessage];
      const assistantArtifacts = turn.assistantText ? extractArtifacts(turn.assistantText) : [];
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

      // LRU 清理：超过上限时移除最旧的会话
      if (sessionMessages.size > SESSION_CACHE_MAX) {
        const oldestKey = sessionMessages.keys().next().value;
        if (oldestKey) sessionMessages.delete(oldestKey);
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
        try {
          // 确保 session 在 DB 中存在（SM 和直写都需要）
          const dbForSession = await deps.getDatabase();
          if (!dbForSession.getSession(sessionId)) {
            dbForSession.createSessionWithId(sessionId, {
              title,
              modelConfig,
            });
          }

          const sm = await deps.tryGetSessionManager();
          const loopPersistedAssistant = await hasPersistedFinalLoopAssistantMessage(
            sessionId,
            turn.lastLoopAssistantMessageId,
            sm,
            dbForSession,
            deps.logger,
          );
          if (sm?.addMessageToSession) {
            // 通过 SM 写入，同时更新 DB 和 sessionCache
            if (!userMessagePrePersistedDb) {
              await sm.addMessageToSession(sessionId, {
                id: userMessage.id,
                role: 'user',
                content: userMessage.content,
                timestamp: userMessage.timestamp,
                attachments: userMessage.attachments,
              } as Message);
            }
            if (!turn.runCancelled && turn.hasAssistantOutput() && !loopPersistedAssistant) {
              await sm.addMessageToSession(sessionId, {
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
          } else {
            // SM 不可用时降级为直写 DB（session 已在上面 ensure 创建）
            const db = await deps.getDatabase();
            if (!userMessagePrePersistedDb) {
              db.addMessage(sessionId, {
                id: userMessage.id,
                role: 'user',
                content: userMessage.content,
                timestamp: userMessage.timestamp,
                attachments: userMessage.attachments,
              } as Message);
            }
            if (!turn.runCancelled && turn.hasAssistantOutput() && !loopPersistedAssistant) {
              db.addMessage(sessionId, {
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
          }
          // 更新会话标题/时间戳
          const db = await deps.getDatabase();
          if (historyLength === 0) {
            db.updateSession(sessionId, { title, updatedAt: Date.now() });
          } else {
            db.updateSession(sessionId, { updatedAt: Date.now() });
          }
        } catch (dbErr) {
          deps.logger.warn('Failed to persist messages to DB:', (dbErr as Error).message);
        }
      }

      return { assistantMsgId };
    },
  };
}

// 兜底判定只认「终轮」assistant 是否落库：早轮已落库不能抑制兜底（终轮落库失败时
// 内容+metadata 会静默丢失）。兜底写的是本 run 合并全文，早轮已在库时触发会有部分
// 内容重复——丢终轮结论比重复早轮片段更不可接受，取舍偏向保内容。
async function hasPersistedFinalLoopAssistantMessage(
  sessionId: string,
  finalMessageId: string | undefined,
  sessionManager: AgentSessionManagerLike | null,
  db: DatabaseService,
  logger: WebRouteLogger,
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
    logger.warn(`[AgentRouter] Failed to verify loop-persisted assistant messages for ${sessionId}:`, error);
    return false;
  }
}
