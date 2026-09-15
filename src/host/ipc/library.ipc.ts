// ============================================================================
// Library IPC Handlers - domain:library 通道（Batch 2 项目资料库）
// ============================================================================
//
// 单一 domain 处理器同时服务桌面原生 IPC 和 HTTP（domain.ts 的
// POST /api/domain/library/:action 走同一处理器）。
//
// actions:
// - list         -> 条目列表（LibraryListOptions）
// - get          -> 单条目（{ itemId }）
// - addItem      -> 登记条目/归档产物（LibraryItemCreateRequest）
// - importFiles  -> 导入本地文件（{ paths, projectId?, tags?, sourceSessionId? }；
//                   web 侧先走 /api/upload/temp 拿临时路径）
// - update       -> 局部更新（{ itemId, title?, tags?, summary?, projectId? }）
// - delete       -> 删除条目（{ itemId }；upload 类连库内文件一起删）
// - getPin       -> 会话 pin（{ sessionId }）
// - setPin       -> 覆盖会话 pin（{ sessionId, itemIds }）
// - pinnedItems  -> 会话 pinned 条目完整元数据（{ sessionId }）
// ============================================================================

import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { LibrarySchemas, type LibraryDomainRequest } from '../../shared/ipc/schemas/library';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getLibraryService } from '../services/library/libraryService';
import type { LibraryItem, LibraryItemCreateRequest, LibraryListOptions } from '../../shared/contract/library';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('LibraryIPC');

interface ItemIdPayload {
  itemId?: string;
}
interface SessionIdPayload {
  sessionId?: string;
}
interface ImportFilesPayload {
  paths?: string[];
  projectId?: string | null;
  tags?: string[];
  sourceSessionId?: string;
}
interface UpdatePayload extends ItemIdPayload {
  title?: string;
  tags?: string[];
  summary?: string | null;
  projectId?: string | null;
}
interface SetPinPayload extends SessionIdPayload {
  itemIds?: string[];
}

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}
function notFound(message: string): IPCResponse {
  return { success: false, error: { code: 'NOT_FOUND', message } };
}

/**
 * library 域单源路由表（RQ-183 续作·LIBRARY 刀）：原 domain switch 9 个 case 逐 case 平移为 handler（rawResponse：
 * case 体直返完整 IPCResponse，含 INVALID_ARGS / NOT_FOUND 失败响应，装配器原样透传）。未知 action →
 * UNKNOWN_ACTION `Unknown library action: <action>`；抛错 → 记带 action 的 error 日志 + LIBRARY_ERROR（Error.message /
 * String(error)），与原 catch 逐字一致。svc 原在 try 外取（抛错即 IPC reject），现在 handler 内取、抛错落 LIBRARY_ERROR；
 * 请求体为 null / 非对象时原实现解构抛错（IPC reject），现返回 UNKNOWN_ACTION。
 */
const libraryHandlers: RawDomainRouteHandlers<LibraryDomainRequest, void> = {
  list: async (_ctx, payload) => {
    const svc = getLibraryService();
    const options = (payload ?? {}) as LibraryListOptions;
    return { success: true, data: svc.list(options) };
  },
  get: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { itemId } = (payload ?? {}) as ItemIdPayload;
    if (!itemId) return invalid('itemId is required');
    const item = svc.get(itemId);
    return item ? { success: true, data: item } : notFound('library item not found');
  },
  addItem: async (_ctx, payload) => {
    const svc = getLibraryService();
    const req = (payload ?? {}) as LibraryItemCreateRequest;
    if (!req.title || !req.kind || !req.pathOrUri) {
      return invalid('title, kind and pathOrUri are required');
    }
    return { success: true, data: svc.addItem(req) };
  },
  importFiles: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { paths, projectId, tags, sourceSessionId } = (payload ?? {}) as ImportFilesPayload;
    const valid = (paths ?? []).filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (valid.length === 0) return invalid('paths is required');
    const items: LibraryItem[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const sourcePath of valid) {
      try {
        items.push(svc.importFile({ projectId, sourcePath, tags, sourceSessionId }));
      } catch (error) {
        errors.push({ path: sourcePath, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { success: true, data: { items, errors } };
  },
  update: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { itemId, title, tags, summary, projectId } = (payload ?? {}) as UpdatePayload;
    if (!itemId) return invalid('itemId is required');
    const item = svc.update(itemId, { title, tags, summary, projectId });
    return item ? { success: true, data: item } : notFound('library item not found');
  },
  delete: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { itemId } = (payload ?? {}) as ItemIdPayload;
    if (!itemId) return invalid('itemId is required');
    return svc.delete(itemId) ? { success: true } : notFound('library item not found');
  },
  getPin: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { sessionId } = (payload ?? {}) as SessionIdPayload;
    if (!sessionId) return invalid('sessionId is required');
    return { success: true, data: svc.getPin(sessionId) };
  },
  setPin: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { sessionId, itemIds } = (payload ?? {}) as SetPinPayload;
    if (!sessionId) return invalid('sessionId is required');
    if (!Array.isArray(itemIds)) return invalid('itemIds must be an array');
    return { success: true, data: svc.setPinnedItems(sessionId, itemIds) };
  },
  pinnedItems: async (_ctx, payload) => {
    const svc = getLibraryService();
    const { sessionId } = (payload ?? {}) as SessionIdPayload;
    if (!sessionId) return invalid('sessionId is required');
    return { success: true, data: svc.getPinnedItems(sessionId) };
  },
};

const libraryRoutes = defineDomainRoutes<LibraryDomainRequest, void>(LibrarySchemas.REQUEST, libraryHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown library action: ${String(action)}`,
  mapError: (error, action) => {
    logger.error('Library IPC failed', { action, error });
    return { code: 'LIBRARY_ERROR', message: error instanceof Error ? error.message : String(error) };
  },
});

export function registerLibraryHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, libraryRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerLibraryHandlers.routes = libraryRoutes;
