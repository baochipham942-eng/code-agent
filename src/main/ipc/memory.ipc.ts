// ============================================================================
// Memory IPC Handlers - memory:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import {
  IPC_CHANNELS,
  IPC_DOMAINS,
  type IPCRequest,
  type IPCResponse,
  type MemoryRecord,
  type MemoryListFilter,
  type MemorySearchOptions,
} from '../../shared/ipc';
import { getSessionManager } from '../services';
import { getMemoryService } from '../memory/memoryService';

// ----------------------------------------------------------------------------
// Types for Memory CRUD Payloads
// ----------------------------------------------------------------------------

interface CreateMemoryPayload {
  type: MemoryRecord['type'];
  category: string;
  content: string;
  summary: string;
  source?: MemoryRecord['source'];
  confidence?: number;
  metadata?: Record<string, unknown>;
}

interface UpdateMemoryPayload {
  id: string;
  updates: {
    category?: string;
    content?: string;
    summary?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  };
}

interface DeleteMemoriesPayload {
  type?: MemoryRecord['type'];
  category?: string;
  source?: MemoryRecord['source'];
  currentProjectOnly?: boolean;
  currentSessionOnly?: boolean;
}

// ----------------------------------------------------------------------------
// Internal Handlers - Legacy (RAG Context)
// ----------------------------------------------------------------------------

async function handleGetContext(payload: { query: string }): Promise<unknown> {
  const memoryService = getMemoryService();
  const ragContext = memoryService.getRAGContext(payload.query);
  const projectKnowledge = memoryService.getProjectKnowledge();
  const relevantCode = memoryService.searchRelevantCode(payload.query);
  const relevantConversations = memoryService.searchRelevantConversations(payload.query);

  return {
    ragContext,
    projectKnowledge: projectKnowledge.map((k) => ({ key: k.key, value: k.value })),
    relevantCode,
    relevantConversations,
  };
}

async function handleSearchCode(payload: { query: string; topK?: number }): Promise<unknown> {
  const memoryService = getMemoryService();
  return memoryService.searchRelevantCode(payload.query, payload.topK);
}

async function handleSearchConversations(payload: { query: string; topK?: number }): Promise<unknown> {
  const memoryService = getMemoryService();
  return memoryService.searchRelevantConversations(payload.query, payload.topK);
}

async function handleGetStats(): Promise<unknown> {
  const sessionManager = getSessionManager();
  const sessions = await sessionManager.listSessions();

  return {
    sessionCount: sessions.length,
    messageCount: sessions.reduce((sum, s) => sum + s.messageCount, 0),
    toolCacheSize: 0,
    vectorStoreSize: 0,
    projectKnowledgeCount: 0,
  };
}

// ----------------------------------------------------------------------------
// Internal Handlers - Memory CRUD (Gen5 记忆可视化)
// ----------------------------------------------------------------------------

async function handleCreateMemory(payload: CreateMemoryPayload): Promise<MemoryRecord> {
  const memoryService = getMemoryService();
  return memoryService.createMemory(payload) as MemoryRecord;
}

async function handleGetMemory(payload: { id: string }): Promise<MemoryRecord | null> {
  const memoryService = getMemoryService();
  return memoryService.getMemoryById(payload.id) as MemoryRecord | null;
}

async function handleListMemories(payload: MemoryListFilter): Promise<MemoryRecord[]> {
  const memoryService = getMemoryService();
  return memoryService.listMemories(payload) as MemoryRecord[];
}

async function handleUpdateMemory(payload: UpdateMemoryPayload): Promise<MemoryRecord | null> {
  const memoryService = getMemoryService();
  return memoryService.updateMemory(payload.id, payload.updates) as MemoryRecord | null;
}

async function handleDeleteMemory(payload: { id: string }): Promise<boolean> {
  const memoryService = getMemoryService();
  return memoryService.deleteMemory(payload.id);
}

async function handleDeleteMemories(payload: DeleteMemoriesPayload): Promise<number> {
  const memoryService = getMemoryService();
  return memoryService.deleteMemories(payload);
}

async function handleSearchMemories(payload: { query: string; options?: MemorySearchOptions }): Promise<MemoryRecord[]> {
  const memoryService = getMemoryService();
  return memoryService.searchMemories(payload.query, payload.options) as MemoryRecord[];
}

async function handleGetMemoryStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
}> {
  const memoryService = getMemoryService();
  return memoryService.getMemoryStats();
}

async function handleRecordMemoryAccess(payload: { id: string }): Promise<void> {
  const memoryService = getMemoryService();
  memoryService.recordMemoryAccess(payload.id);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Memory 相关 IPC handlers
 */
export function registerMemoryHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.MEMORY, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        // Legacy RAG Context actions
        case 'getContext':
          data = await handleGetContext(payload as { query: string });
          break;
        case 'searchCode':
          data = await handleSearchCode(payload as { query: string; topK?: number });
          break;
        case 'searchConversations':
          data = await handleSearchConversations(payload as { query: string; topK?: number });
          break;
        case 'getStats':
          data = await handleGetStats();
          break;

        // Memory CRUD actions (Gen5 记忆可视化)
        case 'createMemory':
          data = await handleCreateMemory(payload as CreateMemoryPayload);
          break;
        case 'getMemory':
          data = await handleGetMemory(payload as { id: string });
          break;
        case 'listMemories':
          data = await handleListMemories((payload || {}) as MemoryListFilter);
          break;
        case 'updateMemory':
          data = await handleUpdateMemory(payload as UpdateMemoryPayload);
          break;
        case 'deleteMemory':
          data = await handleDeleteMemory(payload as { id: string });
          break;
        case 'deleteMemories':
          data = await handleDeleteMemories((payload || {}) as DeleteMemoriesPayload);
          break;
        case 'searchMemories':
          data = await handleSearchMemories(payload as { query: string; options?: MemorySearchOptions });
          break;
        case 'getMemoryStats':
          data = await handleGetMemoryStats();
          break;
        case 'recordAccess':
          await handleRecordMemoryAccess(payload as { id: string });
          data = { success: true };
          break;

        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.MEMORY with action: 'getContext' */
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_CONTEXT, async (_, query: string) =>
    handleGetContext({ query })
  );

  /** @deprecated Use IPC_DOMAINS.MEMORY with action: 'searchCode' */
  ipcMain.handle(IPC_CHANNELS.MEMORY_SEARCH_CODE, async (_, query: string, topK?: number) =>
    handleSearchCode({ query, topK })
  );

  /** @deprecated Use IPC_DOMAINS.MEMORY with action: 'searchConversations' */
  ipcMain.handle(IPC_CHANNELS.MEMORY_SEARCH_CONVERSATIONS, async (_, query: string, topK?: number) =>
    handleSearchConversations({ query, topK })
  );

  /** @deprecated Use IPC_DOMAINS.MEMORY with action: 'getStats' */
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async () => handleGetStats());
}
