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
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
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

export function registerLibraryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.LIBRARY, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;
    const svc = getLibraryService();
    try {
      switch (action) {
        case 'list': {
          const options = (payload ?? {}) as LibraryListOptions;
          return { success: true, data: svc.list(options) };
        }

        case 'get': {
          const { itemId } = (payload ?? {}) as ItemIdPayload;
          if (!itemId) return invalid('itemId is required');
          const item = svc.get(itemId);
          return item ? { success: true, data: item } : notFound('library item not found');
        }

        case 'addItem': {
          const req = (payload ?? {}) as LibraryItemCreateRequest;
          if (!req.title || !req.kind || !req.pathOrUri) {
            return invalid('title, kind and pathOrUri are required');
          }
          return { success: true, data: svc.addItem(req) };
        }

        case 'importFiles': {
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
        }

        case 'update': {
          const { itemId, title, tags, summary, projectId } = (payload ?? {}) as UpdatePayload;
          if (!itemId) return invalid('itemId is required');
          const item = svc.update(itemId, { title, tags, summary, projectId });
          return item ? { success: true, data: item } : notFound('library item not found');
        }

        case 'delete': {
          const { itemId } = (payload ?? {}) as ItemIdPayload;
          if (!itemId) return invalid('itemId is required');
          return svc.delete(itemId) ? { success: true } : notFound('library item not found');
        }

        case 'getPin': {
          const { sessionId } = (payload ?? {}) as SessionIdPayload;
          if (!sessionId) return invalid('sessionId is required');
          return { success: true, data: svc.getPin(sessionId) };
        }

        case 'setPin': {
          const { sessionId, itemIds } = (payload ?? {}) as SetPinPayload;
          if (!sessionId) return invalid('sessionId is required');
          if (!Array.isArray(itemIds)) return invalid('itemIds must be an array');
          return { success: true, data: svc.setPinnedItems(sessionId, itemIds) };
        }

        case 'pinnedItems': {
          const { sessionId } = (payload ?? {}) as SessionIdPayload;
          if (!sessionId) return invalid('sessionId is required');
          return { success: true, data: svc.getPinnedItems(sessionId) };
        }

        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown library action: ${action}` } };
      }
    } catch (error) {
      logger.error('Library IPC failed', { action, error });
      return {
        success: false,
        error: { code: 'LIBRARY_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
