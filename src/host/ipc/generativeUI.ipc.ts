import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { GenerativeUISchemas, type GenerativeUIDomainRequest } from '../../shared/ipc/schemas/generativeUI';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type {
  GenerativeUiEditPersistRequest,
  NeoUIApplyEventRequest,
  NeoUIResolveInstanceRequest,
  NeoUIResolveManifestRequest,
} from '../../shared/contract/generativeUI';
import { getGenerativeUIService } from '../services/generativeUI/generativeUIService';
import { persistGenerativeUiEdit } from '../services/generativeUI/generativeUIEditPersistence';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GenerativeUIIPC');

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}

/**
 * generativeUI 域单源路由表（RQ-183 续作·GENERATIVE_UI 刀）：原 domain switch 逐 case 平移为 handler（rawResponse：
 * handler 仍返回完整 IPCResponse，含 INVALID_ARGS 失败响应，逐字不变）；服务按请求在 handler 内取（原 switch 在 try
 * 外取、抛错即 reject，现走 mapError）；未知 action → UNKNOWN_ACTION `Unknown action: <action>`；抛错 →
 * GENERATIVE_UI_ERROR（Error 取 message、非 Error 取 String(error)）+ 带 action 的 warn 日志。
 */
const generativeUIHandlers: RawDomainRouteHandlers<GenerativeUIDomainRequest, void> = {
  capabilities: async () => {
    const service = getGenerativeUIService();
    return {
      success: true,
      data: {
        nativeGenerativeUI: service.isEnabled(),
        executionManifestV1: service.isManifestEnabled(),
      },
    };
  },
  resolveInstance: async (_ctx, rawPayload) => {
    const payload = rawPayload as NeoUIResolveInstanceRequest | undefined;
    if (!payload?.sessionId || !payload.sourceMessageId || !Number.isInteger(payload.sourceOrdinal) || typeof payload.rawSpec !== 'string') {
      return invalid('sessionId, sourceMessageId, sourceOrdinal and rawSpec are required');
    }
    return { success: true, data: getGenerativeUIService().resolveInstance(payload) };
  },
  applyEvent: async (_ctx, rawPayload) => {
    const payload = rawPayload as NeoUIApplyEventRequest | undefined;
    if (!payload?.event?.eventId || !payload.event.sessionId || !payload.event.instanceId) {
      return invalid('event identity is required');
    }
    return { success: true, data: getGenerativeUIService().applyEvent(payload.event) };
  },
  persistHtmlEdit: async (_ctx, rawPayload) => {
    const payload = rawPayload as GenerativeUiEditPersistRequest | undefined;
    if (
      !payload?.sessionId
      || !payload.messageId
      || !Number.isInteger(payload.sourceOrdinal)
      || typeof payload.baseHash !== 'string'
      || typeof payload.newCode !== 'string'
      || !Array.isArray(payload.fields)
    ) {
      return invalid('sessionId, messageId, sourceOrdinal, baseHash, newCode and fields are required');
    }
    return { success: true, data: await persistGenerativeUiEdit(payload) };
  },
  resolveManifest: async (_ctx, rawPayload) => {
    const payload = rawPayload as NeoUIResolveManifestRequest | undefined;
    if (!payload?.sessionId || !payload.manifestId || !payload.nonce) {
      return invalid('sessionId, manifestId and nonce are required');
    }
    if (payload.decision !== 'approve' && payload.decision !== 'reject') {
      return invalid('decision must be approve or reject');
    }
    return { success: true, data: getGenerativeUIService().resolveManifest(payload) };
  },
};

const generativeUIRoutes = defineDomainRoutes<GenerativeUIDomainRequest, void>(
  GenerativeUISchemas.REQUEST,
  generativeUIHandlers,
  {
    rawResponse: true,
    unknownActionCode: 'UNKNOWN_ACTION',
    mapError: (error, action) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Generative UI domain action failed', { action, message });
      return { code: 'GENERATIVE_UI_ERROR', message };
    },
  },
);

export function registerGenerativeUIHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, generativeUIRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerGenerativeUIHandlers.routes = generativeUIRoutes;
