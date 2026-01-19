// ============================================================================
// Agent IPC Handlers - agent:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { PermissionResponse } from '../../shared/types';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleSendMessage(
  getOrchestrator: () => AgentOrchestrator | null,
  payload: { content: string; attachments?: unknown[] }
): Promise<void> {
  const orchestrator = getOrchestrator();
  if (!orchestrator) throw new Error('Agent not initialized');
  await orchestrator.sendMessage(payload.content, payload.attachments);
}

async function handleCancel(getOrchestrator: () => AgentOrchestrator | null): Promise<void> {
  const orchestrator = getOrchestrator();
  if (!orchestrator) throw new Error('Agent not initialized');
  await orchestrator.cancel();
}

async function handlePermissionResponse(
  getOrchestrator: () => AgentOrchestrator | null,
  payload: { requestId: string; response: PermissionResponse }
): Promise<void> {
  const orchestrator = getOrchestrator();
  if (!orchestrator) throw new Error('Agent not initialized');
  orchestrator.handlePermissionResponse(payload.requestId, payload.response);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Agent 相关 IPC handlers
 */
export function registerAgentHandlers(
  ipcMain: IpcMain,
  getOrchestrator: () => AgentOrchestrator | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.AGENT, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'send':
          await handleSendMessage(getOrchestrator, payload as { content: string; attachments?: unknown[] });
          return { success: true, data: null };
        case 'cancel':
          await handleCancel(getOrchestrator);
          return { success: true, data: null };
        case 'permissionResponse':
          await handlePermissionResponse(getOrchestrator, payload as { requestId: string; response: PermissionResponse });
          return { success: true, data: null };
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
    async (_, payload: string | { content: string; attachments?: unknown[] }) => {
      const content = typeof payload === 'string' ? payload : payload.content;
      const attachments = typeof payload === 'object' && payload !== null ? payload.attachments : undefined;
      return handleSendMessage(getOrchestrator, { content, attachments });
    }
  );

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'cancel' */
  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async () => {
    return handleCancel(getOrchestrator);
  });

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'permissionResponse' */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_, requestId: string, response: PermissionResponse) => {
      return handlePermissionResponse(getOrchestrator, { requestId, response });
    }
  );
}
