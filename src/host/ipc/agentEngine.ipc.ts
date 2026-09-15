// ============================================================================
// Agent Engine IPC
// ============================================================================

import type { IpcMain } from '../platform';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { AgentEngineSchemas, type AgentEngineDomainRequest } from '../../shared/ipc/schemas/agentEngine';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type {
  AgentEngineKind,
  AgentEnginePermissionProfile,
  ExternalAgentEngineKind,
} from '../../shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import { AgentEngineCapabilityError } from '../../shared/contract/agentEngine';
import { getAgentEngineRegistry } from '../services/agentEngine';
import {
  buildManualAgentEngineSelection,
  isExternalAgentEngine,
} from '../services/agentEngine/agentEngineGuards';
import {
  AgentEngineModelIncompatibleError,
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
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

function isExternalEngineKind(kind: AgentEngineKind | undefined): kind is ExternalAgentEngineKind {
  // 单一真源：external engine 列表统一由 agentEngineGuards.isExternalAgentEngine 维护，
  // 这里只追加类型收窄（narrowing），避免引擎清单在 IPC 层重复定义而漏同步 mimo/kimi。
  return kind !== undefined && isExternalAgentEngine(kind);
}

/**
 * agent engine 域单源路由表（RQ-183 续作·AGENT_ENGINE 刀）：原 domain switch 9 个 case 逐 case 平移为 handler（rawResponse：
 * 业务失败 INVALID_PAYLOAD / SESSION_NOT_FOUND / INVALID_ENGINE / MODEL_NOT_FOUND / MODEL_DISABLED 原样直返，成功路径包
 * `{ success: true, data }`）。未知 action 用装配器缺省（INVALID_ACTION `Unknown action: <action>`，与原文逐字一致）。抛错映射原样
 * 进 mapError：AgentEngineCapabilityError / AgentEngineHistoryImportError 取自带 code + details，AgentEngineModelIncompatibleError →
 * MODEL_NOT_FOUND + details，其余 INTERNAL_ERROR（无 details 键）。registry 原在 try 外取（抛错即 IPC reject），现在 handler 内取、
 * 抛错落 INTERNAL_ERROR；请求体为 null / 非对象时原实现在 try 内读 request.action 抛错落 INTERNAL_ERROR，现返回 INVALID_ACTION。
 */
const agentEngineHandlers: RawDomainRouteHandlers<AgentEngineDomainRequest, void> = {
  detect: async (_ctx, _requestPayload) => {
    const registry = getAgentEngineRegistry();
    // 「检测引擎」按钮：两套缓存都失效并等待新事实。普通目录读取可以 SWR，
    // 但用户显式发起的检测不能拿刚失效的旧目录冒充检测结果。
    registry.invalidate();
    const catalogService = getRemoteAgentEngineModelCatalogService();
    catalogService.invalidate();
    const [data] = await Promise.all([
      registry.list(),
      catalogService.readCatalog(),
    ]);
    return { success: true, data };
  },
  list: async (_ctx, _requestPayload) => {
    const registry = getAgentEngineRegistry();
    const data = await registry.list();
    return { success: true, data };
  },
  listSources: async (_ctx, _requestPayload) => {
    const registry = getAgentEngineRegistry();
    const data = await registry.listSources();
    return { success: true, data };
  },
  get: async (_ctx, requestPayload) => {
    const registry = getAgentEngineRegistry();
    const data = await registry.get((requestPayload as { kind: AgentEngineKind }).kind);
    return { success: true, data };
  },
  listModels: async (_ctx, _requestPayload) => {
    const data = await getRemoteAgentEngineModelCatalogService().readCatalog();
    return { success: true, data };
  },
  select: async (_ctx, requestPayload) => {
    const registry = getAgentEngineRegistry();
    const payload = requestPayload as {
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
      ? await getRemoteAgentEngineModelCatalogService()
        .resolveModelId(payload.kind, payload.model, { strict: true })
      : undefined;
    let effectiveWorkingDirectory = payload.workingDirectory?.trim() || session?.workingDirectory?.trim() || '';
    if (!effectiveWorkingDirectory && isExternalEngineKind(payload.kind)) {
      // 快速对话 + app 级都没有目录：兜到默认工作目录 <dataDir>/work
      // （与 web /api/run 的 ensureDefaultWebWorkingDirectory 同一真相源；
      // 产品负责人 2026-08-05 拍板：不弹目录选择器，直接用通用默认夹）。
      const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim() || nodePath.join(os.homedir(), '.code-agent');
      effectiveWorkingDirectory = nodePath.join(nodePath.resolve(dataDir), 'work');
      await fsp.mkdir(effectiveWorkingDirectory, { recursive: true });
    }
    const sessionForSelection = session && effectiveWorkingDirectory
      ? { ...session, workingDirectory: effectiveWorkingDirectory }
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
    const data = engine;
    return { success: true, data };
  },
  selectModel: async (_ctx, requestPayload) => {
    const registry = getAgentEngineRegistry();
    const payload = requestPayload as {
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
    const data = engine;
    return { success: true, data };
  },
  listHistory: async (_ctx, requestPayload) => {
    const data = await getAgentEngineHistoryImportService()
      .listHistory(requestPayload as AgentEngineHistoryListRequest);
    return { success: true, data };
  },
  previewHistory: async (_ctx, requestPayload) => {
    const data = await getAgentEngineHistoryImportService()
      .previewHistory(requestPayload as AgentEngineHistoryPreviewRequest);
    return { success: true, data };
  },
};

const agentEngineRoutes = defineDomainRoutes<AgentEngineDomainRequest, void>(AgentEngineSchemas.REQUEST, agentEngineHandlers, {
  rawResponse: true,
  mapError: (error) => {
    if (error instanceof AgentEngineCapabilityError) {
      return {
        code: error.code,
        message: error.message,
        details: { engine: error.engine, capability: error.capability },
      };
    }
    if (error instanceof AgentEngineModelIncompatibleError) {
      return {
        code: 'MODEL_NOT_FOUND',
        message: error.message,
        details: { engine: error.kind, model: error.requestedModel },
      };
    }
    if (error instanceof AgentEngineHistoryImportError) {
      return {
        code: error.code,
        message: error.message,
        details: error.details,
      };
    }
    return {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
  },
});

export function registerAgentEngineHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, agentEngineRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerAgentEngineHandlers.routes = agentEngineRoutes;
