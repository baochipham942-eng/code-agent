// ============================================================================
// libraryClient - 渲染层资料库 domain API 封装（Batch 2）
// ============================================================================
//
// 走 ipcService.invokeDomain(IPC_DOMAINS.LIBRARY, action, payload)，桌面原生 IPC
// 与 HTTP 双链路统一。web 侧文件先经 /api/upload/temp 落地再 importFiles。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import type {
  LibraryItem,
  LibraryItemCreateRequest,
  LibraryListOptions,
  SessionContextPin,
} from '@shared/contract/library';
import ipcService from './ipcService';

export interface LibraryImportResult {
  items: LibraryItem[];
  errors: Array<{ path: string; message: string }>;
}

export async function listLibraryItems(options?: LibraryListOptions): Promise<LibraryItem[]> {
  return ipcService.invokeDomain<LibraryItem[]>(IPC_DOMAINS.LIBRARY, 'list', options ?? {});
}

export async function addLibraryItem(request: LibraryItemCreateRequest): Promise<LibraryItem> {
  return ipcService.invokeDomain<LibraryItem>(IPC_DOMAINS.LIBRARY, 'addItem', request);
}

export async function importLibraryFiles(args: {
  paths: string[];
  projectId?: string | null;
  tags?: string[];
  sourceSessionId?: string;
}): Promise<LibraryImportResult> {
  return ipcService.invokeDomain<LibraryImportResult>(IPC_DOMAINS.LIBRARY, 'importFiles', args);
}

export async function deleteLibraryItem(itemId: string): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.LIBRARY, 'delete', { itemId });
}

export async function getSessionPin(sessionId: string): Promise<SessionContextPin> {
  return ipcService.invokeDomain<SessionContextPin>(IPC_DOMAINS.LIBRARY, 'getPin', { sessionId });
}

export async function setSessionPin(sessionId: string, itemIds: string[]): Promise<SessionContextPin> {
  return ipcService.invokeDomain<SessionContextPin>(IPC_DOMAINS.LIBRARY, 'setPin', { sessionId, itemIds });
}
