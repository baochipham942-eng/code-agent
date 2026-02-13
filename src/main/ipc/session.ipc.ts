// ============================================================================
// Session IPC Handlers - session:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getSessionManager } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getMemoryTriggerService, type SessionMemoryContext } from '../memory/memoryTriggerService';
import type { ConfigService } from '../services';
import type { GenerationManager } from '../generation/generationManager';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { Session, Message } from '../../shared/types';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../shared/constants';
import { getModelSessionState } from '../session/modelSessionState';
import type { ModelProvider } from '../../shared/types';

interface SessionHandlerDeps {
  getConfigService: () => ConfigService | null;
  getGenerationManager: () => GenerationManager | null;
  getOrchestrator: () => AgentOrchestrator | null;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string) => void;
}

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleList(options?: { includeArchived?: boolean }): Promise<Session[]> {
  const sessionManager = getSessionManager();
  return sessionManager.listSessions({ includeArchived: options?.includeArchived });
}

async function handleArchive(payload: { sessionId: string }): Promise<Session | null> {
  const sessionManager = getSessionManager();
  return sessionManager.archiveSession(payload.sessionId);
}

async function handleUnarchive(payload: { sessionId: string }): Promise<Session | null> {
  const sessionManager = getSessionManager();
  return sessionManager.unarchiveSession(payload.sessionId);
}

async function handleCreate(
  deps: SessionHandlerDeps,
  payload?: { title?: string }
): Promise<Session> {
  const { getConfigService, getGenerationManager, getOrchestrator, setCurrentSessionId } = deps;
  const configService = getConfigService();
  const generationManager = getGenerationManager();
  const orchestrator = getOrchestrator();

  if (!configService || !generationManager) {
    throw new Error('Services not initialized');
  }

  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();
  const memoryTrigger = getMemoryTriggerService();
  const settings = configService.getSettings();
  const currentGen = generationManager.getCurrentGeneration();
  const workingDirectory = orchestrator?.getWorkingDirectory();

  const session = await sessionManager.createSession({
    title: payload?.title || 'New Session',
    generationId: currentGen.id,
    modelConfig: {
      provider: settings.model?.provider || DEFAULT_PROVIDER,
      model: settings.model?.model || DEFAULT_MODELS.chat,
      temperature: settings.model?.temperature || 0.7,
      maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
    },
    workingDirectory,
  });

  sessionManager.setCurrentSession(session.id);
  setCurrentSessionId(session.id);

  // 关键：创建新会话时必须清空 orchestrator 的消息历史，防止上下文污染
  if (orchestrator) {
    orchestrator.clearMessages();
  }

  memoryService.setContext(session.id, workingDirectory || undefined);

  // Gen5: Trigger memory retrieval on session start (async, non-blocking)
  memoryTrigger.onSessionStart(session.id, workingDirectory).catch((err) => {
    // Log but don't fail session creation
    console.warn('Memory trigger failed:', err);
  });

  return session;
}

async function handleLoad(
  deps: SessionHandlerDeps,
  payload: { sessionId: string }
): Promise<Session> {
  const { getOrchestrator, setCurrentSessionId } = deps;
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();
  const memoryTrigger = getMemoryTriggerService();
  const orchestrator = getOrchestrator();

  const session = await sessionManager.restoreSession(payload.sessionId);
  if (!session) {
    throw new Error(`Session ${payload.sessionId} not found`);
  }

  setCurrentSessionId(payload.sessionId);

  memoryService.setContext(payload.sessionId, session.workingDirectory || undefined);

  if (orchestrator) {
    // 关键：同步消息历史到 orchestrator，否则模型看不到之前的对话上下文
    if (session.messages && session.messages.length > 0) {
      orchestrator.setMessages(session.messages);
    } else {
      orchestrator.clearMessages();
    }

    if (session.workingDirectory) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }
  }

  // Gen5: Trigger memory retrieval on session load (async, non-blocking)
  memoryTrigger.onSessionStart(payload.sessionId, session.workingDirectory).catch((err) => {
    // Log but don't fail session load
    console.warn('Memory trigger failed:', err);
  });

  return session;
}

async function handleDelete(
  deps: SessionHandlerDeps,
  payload: { sessionId: string }
): Promise<void> {
  const { getConfigService, getGenerationManager, getCurrentSessionId, setCurrentSessionId } = deps;
  const sessionManager = getSessionManager();
  const configService = getConfigService();
  const generationManager = getGenerationManager();
  const currentSessionId = getCurrentSessionId();

  await sessionManager.deleteSession(payload.sessionId);

  if (payload.sessionId === currentSessionId) {
    const settings = configService!.getSettings();
    const currentGen = generationManager!.getCurrentGeneration();

    const newSession = await sessionManager.createSession({
      title: 'New Session',
      generationId: currentGen.id,
      modelConfig: {
        provider: settings.model?.provider || DEFAULT_PROVIDER,
        model: settings.model?.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
      },
    });

    sessionManager.setCurrentSession(newSession.id);
    setCurrentSessionId(newSession.id);

    const memoryService = getMemoryService();
    memoryService.setContext(newSession.id);
  }
}

async function handleGetMessages(payload: { sessionId: string }): Promise<Message[]> {
  const sessionManager = getSessionManager();
  return sessionManager.getMessages(payload.sessionId);
}

async function handleExport(payload: { sessionId: string }): Promise<unknown> {
  const sessionManager = getSessionManager();
  return sessionManager.exportSession(payload.sessionId);
}

async function handleImport(payload: { data: unknown }): Promise<string> {
  const sessionManager = getSessionManager();
  // SessionManager expects SessionWithMessages type
  // Input is validated by SessionManager.importSession
  return sessionManager.importSession(payload.data as import('../services').SessionWithMessages);
}

async function handleGetMemoryContext(
  payload: { sessionId: string; workingDirectory?: string; query?: string }
): Promise<SessionMemoryContext> {
  const memoryTrigger = getMemoryTriggerService();
  return memoryTrigger.onSessionStart(
    payload.sessionId,
    payload.workingDirectory,
    payload.query
  );
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Session 相关 IPC handlers
 */
export function registerSessionHandlers(ipcMain: IpcMain, deps: SessionHandlerDeps): void {
  const {
    getConfigService,
    getGenerationManager,
    getOrchestrator,
    getCurrentSessionId,
    setCurrentSessionId,
  } = deps;

  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.SESSION, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'list':
          data = await handleList(payload as { includeArchived?: boolean } | undefined);
          break;
        case 'create':
          data = await handleCreate(deps, payload as { title?: string });
          break;
        case 'load':
          data = await handleLoad(deps, payload as { sessionId: string });
          break;
        case 'delete':
          await handleDelete(deps, payload as { sessionId: string });
          data = null;
          break;
        case 'getMessages':
          data = await handleGetMessages(payload as { sessionId: string });
          break;
        case 'export':
          data = await handleExport(payload as { sessionId: string });
          break;
        case 'import':
          data = await handleImport(payload as { data: unknown });
          break;
        case 'getMemoryContext':
          data = await handleGetMemoryContext(
            payload as { sessionId: string; workingDirectory?: string; query?: string }
          );
          break;
        case 'archive':
          data = await handleArchive(payload as { sessionId: string });
          break;
        case 'unarchive':
          data = await handleUnarchive(payload as { sessionId: string });
          break;
        case 'switchModel': {
          // E4: 运行时模型热切换
          const { sessionId: sid, provider, model, temperature, maxTokens } =
            payload as { sessionId: string; provider: string; model: string; temperature?: number; maxTokens?: number };
          const modelState = getModelSessionState();
          modelState.setOverride(sid, {
            provider: provider as ModelProvider,
            model,
            temperature,
            maxTokens,
          });
          data = { provider, model };
          break;
        }
        case 'getModelOverride': {
          const { sessionId: sid2 } = payload as { sessionId: string };
          const modelState2 = getModelSessionState();
          data = modelState2.getOverride(sid2);
          break;
        }
        case 'clearModelOverride': {
          const { sessionId: sid3 } = payload as { sessionId: string };
          const modelState3 = getModelSessionState();
          modelState3.clearOverride(sid3);
          data = null;
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

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'list' */
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (_, options?: { includeArchived?: boolean }) => {
    return handleList(options);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'archive' */
  ipcMain.handle(IPC_CHANNELS.SESSION_ARCHIVE, async (_, sessionId: string) => {
    return handleArchive({ sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'unarchive' */
  ipcMain.handle(IPC_CHANNELS.SESSION_UNARCHIVE, async (_, sessionId: string) => {
    return handleUnarchive({ sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'create' */
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_, title?: string) => {
    return handleCreate(deps, { title });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'load' */
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_, sessionId: string) => {
    return handleLoad(deps, { sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'delete' */
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionId: string) => {
    return handleDelete(deps, { sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'getMessages' */
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (_, sessionId: string) => {
    return handleGetMessages({ sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'export' */
  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_, sessionId: string) => {
    return handleExport({ sessionId });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'import' */
  ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async (_, data: unknown) => {
    return handleImport({ data });
  });
}
