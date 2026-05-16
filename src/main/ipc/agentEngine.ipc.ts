// ============================================================================
// Agent Engine IPC
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AgentEngineKind, AgentEnginePermissionProfile } from '../../shared/contract/agentEngine';
import { getAgentEngineRegistry } from '../services/agentEngine';
import { buildManualAgentEngineSelection } from '../services/agentEngine/agentEngineGuards';
import {
  AgentEngineHistoryImportError,
  getAgentEngineHistoryImportService,
  type AgentEngineHistoryListRequest,
  type AgentEngineHistoryPreviewRequest,
} from '../services/agentEngine/agentEngineHistoryImport';
import { getSessionManager } from '../services/infra/sessionManager';

export function registerAgentEngineHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.AGENT_ENGINE, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const registry = getAgentEngineRegistry();

    try {
      let data: unknown;
      switch (request.action) {
        case 'list':
        case 'detect':
          data = await registry.list();
          break;
        case 'get':
          data = await registry.get((request.payload as { kind: AgentEngineKind }).kind);
          break;
        case 'select': {
          const payload = request.payload as {
            sessionId?: string;
            kind?: AgentEngineKind;
            permissionProfile?: AgentEnginePermissionProfile;
          };
          if (!payload.sessionId || !payload.kind) {
            return {
              success: false,
              error: {
                code: 'INVALID_PAYLOAD',
                message: 'Agent Engine selection requires sessionId and kind.',
              },
            };
          }
          const sessionManager = getSessionManager();
          const session = await sessionManager.getSession(payload.sessionId, 1);
          const descriptor = await registry.get(payload.kind);
          const engine = buildManualAgentEngineSelection(
            session,
            descriptor,
            payload.permissionProfile,
          );
          await sessionManager.updateSession(
            payload.sessionId,
            { engine, updatedAt: engine.updatedAt ?? Date.now() },
            { allowEngineUpdate: true },
          );
          data = engine;
          break;
        }
        case 'listHistory':
          data = await getAgentEngineHistoryImportService()
            .listHistory(request.payload as AgentEngineHistoryListRequest);
          break;
        case 'previewHistory':
          data = await getAgentEngineHistoryImportService()
            .previewHistory(request.payload as AgentEngineHistoryPreviewRequest);
          break;
        default:
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: `Unknown action: ${request.action}`,
            },
          };
      }

      return { success: true, data };
    } catch (error) {
      if (error instanceof AgentEngineHistoryImportError) {
        return {
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
