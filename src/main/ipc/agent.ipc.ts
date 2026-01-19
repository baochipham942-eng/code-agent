// ============================================================================
// Agent IPC Handlers - agent:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { PermissionResponse } from '../../shared/types';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';

/**
 * 注册 Agent 相关 IPC handlers
 */
export function registerAgentHandlers(
  ipcMain: IpcMain,
  getOrchestrator: () => AgentOrchestrator | null
): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_MESSAGE,
    async (_, payload: string | { content: string; attachments?: unknown[] }) => {
      console.log('[IPC] AGENT_SEND_MESSAGE raw payload type:', typeof payload);
      console.log('[IPC] AGENT_SEND_MESSAGE payload is null:', payload === null);
      console.log(
        '[IPC] AGENT_SEND_MESSAGE payload keys:',
        typeof payload === 'object' && payload !== null ? Object.keys(payload) : 'N/A'
      );

      const content = typeof payload === 'string' ? payload : payload.content;
      const attachments =
        typeof payload === 'object' && payload !== null ? payload.attachments : undefined;
      console.log(
        '[IPC] AGENT_SEND_MESSAGE parsed - content:',
        content?.substring(0, 50),
        'attachments:',
        attachments?.length || 0
      );
      if (attachments?.length) {
        console.log(
          '[IPC] Attachment details:',
          attachments.map((a: any) => ({
            name: a.name,
            type: a.type,
            category: a.category,
            hasData: !!a.data,
            dataLength: a.data?.length,
            path: a.path,
            hasPath: !!a.path,
          }))
        );
      }

      const orchestrator = getOrchestrator();
      if (!orchestrator) throw new Error('Agent not initialized');

      try {
        await orchestrator.sendMessage(content, attachments);
        console.log('[IPC] AGENT_SEND_MESSAGE completed');
      } catch (error) {
        console.error('[IPC] AGENT_SEND_MESSAGE error:', error);
        throw error;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async () => {
    const orchestrator = getOrchestrator();
    if (!orchestrator) throw new Error('Agent not initialized');
    await orchestrator.cancel();
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_, requestId: string, response: PermissionResponse) => {
      const orchestrator = getOrchestrator();
      if (!orchestrator) throw new Error('Agent not initialized');
      orchestrator.handlePermissionResponse(requestId, response);
    }
  );
}
