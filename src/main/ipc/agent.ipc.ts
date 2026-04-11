// ============================================================================
// Agent IPC Handlers - agent:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import {
  IPC_CHANNELS,
  IPC_DOMAINS,
  type AgentCancelRequest,
  type AgentPermissionResponseRequest,
  type IPCRequest,
  type IPCResponse
} from '../../shared/ipc';
import type { PermissionResponse } from '../../shared/types';
import type { AgentApplicationService, AppServiceRunOptions } from '../../shared/types/appService';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

interface SendMessagePayload {
  content: string;
  sessionId?: string;
  attachments?: unknown[];
  options?: AppServiceRunOptions;
}

async function handleSendMessage(
  getAppService: () => AgentApplicationService | null,
  payload: SendMessagePayload
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  await appService.sendMessage(payload.content, payload.attachments, payload.options, payload.sessionId);
}

async function handleCancel(
  getAppService: () => AgentApplicationService | null,
  payload?: AgentCancelRequest
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  await appService.cancel(payload?.sessionId);
}

async function handlePermissionResponse(
  getAppService: () => AgentApplicationService | null,
  payload: AgentPermissionResponseRequest
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  appService.handlePermissionResponse(payload.requestId, payload.response, payload.sessionId);
}

interface InterruptPayload {
  content: string;
  sessionId?: string;
  attachments?: unknown[];
}

async function handleInterrupt(
  getAppService: () => AgentApplicationService | null,
  payload: InterruptPayload
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  await appService.interruptAndContinue(payload.content, payload.attachments, payload.sessionId);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Agent 相关 IPC handlers
 */
export function registerAgentHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.AGENT, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'send':
          await handleSendMessage(getAppService, payload as SendMessagePayload);
          return { success: true, data: null };
        case 'cancel':
          await handleCancel(getAppService, payload as AgentCancelRequest | undefined);
          return { success: true, data: null };
        case 'permissionResponse':
          await handlePermissionResponse(getAppService, payload as AgentPermissionResponseRequest);
          return { success: true, data: null };
        case 'interrupt':
          await handleInterrupt(getAppService, payload as InterruptPayload);
          return { success: true, data: null };
        case 'setEffortLevel': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.setEffortLevel((payload as { level: import('../../shared/types/agent').EffortLevel }).level);
          return { success: true, data: null };
        }
        case 'setInteractionMode': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.setInteractionMode((payload as { mode: import('../../shared/types/agent').InteractionMode }).mode);
          return { success: true, data: null };
        }
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'send' */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_MESSAGE,
    async (_, payload: string | SendMessagePayload) => {
      if (typeof payload === 'string') {
        return handleSendMessage(getAppService, { content: payload });
      }
      return handleSendMessage(getAppService, payload);
    }
  );

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'cancel' */
  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async (_, payload?: AgentCancelRequest) => {
    return handleCancel(getAppService, payload);
  });

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'permissionResponse' */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_, requestId: string, response: PermissionResponse, sessionId?: string) => {
      return handlePermissionResponse(getAppService, { requestId, response, sessionId });
    }
  );
}
