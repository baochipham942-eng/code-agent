// ============================================================================
// Agent Engine IPC
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type {
  AgentEngineKind,
  AgentEnginePermissionProfile,
  ExternalAgentEngineKind,
} from '../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import { getAgentEngineRegistry } from '../services/agentEngine';
import {
  buildManualAgentEngineSelection,
  isExternalAgentEngine,
} from '../services/agentEngine/agentEngineGuards';
import {
  getAgentEngineCatalogEngine,
  getRemoteAgentEngineModelCatalogService,
  resolveAgentEngineCatalogModel,
} from '../services/agentEngine/agentEngineModelCatalog';
import {
  AgentEngineHistoryImportError,
  getAgentEngineHistoryImportService,
  type AgentEngineHistoryListRequest,
  type AgentEngineHistoryPreviewRequest,
} from '../services/agentEngine/agentEngineHistoryImport';
import { getSessionManager } from '../services/infra/sessionManager';

function isExternalEngineKind(kind: AgentEngineKind | undefined): kind is ExternalAgentEngineKind {
  // 单一真源：external engine 列表统一由 agentEngineGuards.isExternalAgentEngine 维护，
  // 这里只追加类型收窄（narrowing），避免引擎清单在 IPC 层重复定义而漏同步 mimo/kimi。
  return kind !== undefined && isExternalAgentEngine(kind);
}

export function registerAgentEngineHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.AGENT_ENGINE, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const registry = getAgentEngineRegistry();

    try {
      let data: unknown;
      switch (request.action) {
        case 'detect':
          // 「检测引擎」按钮：强制重探（绕过 5s 探测缓存），覆盖"刚装好引擎"的场景。
          registry.invalidate();
          data = await registry.list();
          break;
        case 'list':
          data = await registry.list();
          break;
        case 'get':
          data = await registry.get((request.payload as { kind: AgentEngineKind }).kind);
          break;
        case 'listModels':
          data = await getRemoteAgentEngineModelCatalogService().readCatalog();
          break;
        case 'select': {
          const payload = request.payload as {
            sessionId?: string;
            kind?: AgentEngineKind;
            permissionProfile?: AgentEnginePermissionProfile;
            model?: string | null;
            workingDirectory?: string | null;
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
          const selectedModel = isExternalEngineKind(payload.kind)
            ? await getRemoteAgentEngineModelCatalogService().resolveModelId(payload.kind, payload.model)
            : undefined;
          const sessionForSelection = session && payload.workingDirectory?.trim()
            ? { ...session, workingDirectory: payload.workingDirectory.trim() }
            : session;
          const engine = buildManualAgentEngineSelection(
            sessionForSelection,
            descriptor,
            payload.permissionProfile,
            selectedModel,
          );
          await sessionManager.updateSession(
            payload.sessionId,
            {
              engine,
              workingDirectory: sessionForSelection?.workingDirectory,
              updatedAt: engine.updatedAt ?? Date.now(),
            },
            { allowEngineUpdate: true },
          );
          data = engine;
          break;
        }
        case 'selectModel': {
          const payload = request.payload as {
            sessionId?: string;
            kind?: AgentEngineKind;
            model?: string;
          };
          if (!payload.sessionId || !payload.model?.trim()) {
            return {
              success: false,
              error: {
                code: 'INVALID_PAYLOAD',
                message: 'Agent Engine model selection requires sessionId and model.',
              },
            };
          }

          const sessionManager = getSessionManager();
          const session = await sessionManager.getSession(payload.sessionId, 1);
          if (!session) {
            return {
              success: false,
              error: {
                code: 'SESSION_NOT_FOUND',
                message: 'Session not found for Agent Engine model selection.',
              },
            };
          }

          const currentEngine = normalizeAgentEngineSession(session.engine);
          const targetKind = payload.kind ?? currentEngine.kind;
          if (!isExternalEngineKind(targetKind)) {
            return {
              success: false,
              error: {
                code: 'INVALID_ENGINE',
                message: 'Native Neo model selection uses the normal model provider settings.',
              },
            };
          }

          const catalogResult = await getRemoteAgentEngineModelCatalogService().readCatalog();
          const catalogEngine = getAgentEngineCatalogEngine(catalogResult.catalog, targetKind);
          const model = catalogEngine?.models.find((entry) => entry.id === payload.model?.trim());
          if (!catalogEngine || !model) {
            return {
              success: false,
              error: {
                code: 'MODEL_NOT_FOUND',
                message: 'Selected Agent Engine model is not present in the signed catalog.',
              },
            };
          }
          if (model.disabledReason) {
            return {
              success: false,
              error: {
                code: 'MODEL_DISABLED',
                message: model.disabledReason,
              },
            };
          }

          let engine;
          if (currentEngine.kind === targetKind) {
            const fallbackModel = resolveAgentEngineCatalogModel(catalogResult.catalog, targetKind, model.id)?.id ?? model.id;
            engine = normalizeAgentEngineSession({
              ...currentEngine,
              kind: targetKind,
              model: fallbackModel,
              updatedAt: Date.now(),
            });
          } else {
            const descriptor = await registry.get(targetKind);
            engine = buildManualAgentEngineSelection(
              session,
              descriptor,
              descriptor.defaultPermissionProfile,
              model.id,
            );
          }

          await sessionManager.updateSession(
            payload.sessionId,
            {
              engine,
              updatedAt: engine.updatedAt ?? Date.now(),
            },
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
