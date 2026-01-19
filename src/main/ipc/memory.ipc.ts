// ============================================================================
// Memory IPC Handlers - memory:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getDatabase, getSessionManager } from '../services';
import { getMemoryService } from '../memory/MemoryService';
import { getMCPClient } from '../mcp/MCPClient';

/**
 * 注册 Memory 相关 IPC handlers
 */
export function registerMemoryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_CONTEXT, async (_, query: string) => {
    const memoryService = getMemoryService();
    const ragContext = memoryService.getRAGContext(query);
    const projectKnowledge = memoryService.getProjectKnowledge();
    const relevantCode = memoryService.searchRelevantCode(query);
    const relevantConversations = memoryService.searchRelevantConversations(query);

    return {
      ragContext,
      projectKnowledge: projectKnowledge.map((k) => ({ key: k.key, value: k.value })),
      relevantCode,
      relevantConversations,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH_CODE,
    async (_, query: string, topK?: number) => {
      const memoryService = getMemoryService();
      return memoryService.searchRelevantCode(query, topK);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH_CONVERSATIONS,
    async (_, query: string, topK?: number) => {
      const memoryService = getMemoryService();
      return memoryService.searchRelevantConversations(query, topK);
    }
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async () => {
    const db = getDatabase();
    const sessionManager = getSessionManager();
    const mcpClient = getMCPClient();

    const sessions = await sessionManager.listSessions();
    const mcpStatus = mcpClient.getStatus();

    return {
      sessionCount: sessions.length,
      messageCount: sessions.reduce((sum, s) => sum + s.messageCount, 0),
      toolCacheSize: 0,
      vectorStoreSize: 0,
      projectKnowledgeCount: 0,
    };
  });
}
