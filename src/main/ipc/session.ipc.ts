// ============================================================================
// Session IPC Handlers - session:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AgentApplicationService, SwitchModelParams } from '../../shared/types/appService';
import type { SessionMemoryContext } from '../memory/memoryTriggerService';

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
          data = await requireAppService().createSession(payload as { title?: string });
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
        case 'export':
          data = await requireAppService().exportSession((payload as { sessionId: string }).sessionId);
          break;
        case 'import':
          data = await requireAppService().importSession((payload as { data: unknown }).data);
          break;
        case 'getMemoryContext': {
          const p = payload as { sessionId: string; workingDirectory?: string; query?: string };
          data = await requireAppService().getMemoryContext(p.sessionId, p.workingDirectory, p.query) as SessionMemoryContext;
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
          requireAppService().switchModel(p);
          data = { provider: p.provider, model: p.model };
          break;
        }
        case 'getModelOverride': {
          const { sessionId } = payload as { sessionId: string };
          data = requireAppService().getModelOverride(sessionId);
          break;
        }
        case 'clearModelOverride': {
          const { sessionId } = payload as { sessionId: string };
          requireAppService().clearModelOverride(sessionId);
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
    return requireAppService().listSessions(options);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'archive' */
  ipcMain.handle(IPC_CHANNELS.SESSION_ARCHIVE, async (_, sessionId: string) => {
    return requireAppService().archiveSession(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'unarchive' */
  ipcMain.handle(IPC_CHANNELS.SESSION_UNARCHIVE, async (_, sessionId: string) => {
    return requireAppService().unarchiveSession(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'create' */
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_, title?: string) => {
    return requireAppService().createSession({ title });
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'load' */
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_, sessionId: string) => {
    return requireAppService().loadSession(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'delete' */
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionId: string) => {
    return requireAppService().deleteSession(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'getMessages' */
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (_, sessionId: string) => {
    return requireAppService().getMessages(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'export' */
  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_, sessionId: string) => {
    return requireAppService().exportSession(sessionId);
  });

  /** @deprecated Use IPC_DOMAINS.SESSION with action: 'import' */
  ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async (_, data: unknown) => {
    return requireAppService().importSession(data);
  });

  // Load older messages (pagination)
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_OLDER_MESSAGES, async (_, payload: { sessionId: string; beforeTimestamp: number; limit?: number }) => {
    return requireAppService().loadOlderMessages(payload.sessionId, payload.beforeTimestamp, payload.limit ?? 30);
  });
}
