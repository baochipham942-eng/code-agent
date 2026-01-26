// ============================================================================
// Memory IPC Handlers - memory:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getSessionManager, getDatabase } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getVectorStore } from '../memory/vectorStore';
import type { MemoryItem, MemoryCategory, MemoryExport, MemoryStats } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryIPC');

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * 格式化复杂值为人类可读的字符串
 * 避免直接显示原始 JSON 给用户
 */
function formatValueForDisplay(key: string, value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  // 特殊处理 tool_preferences：工具使用统计
  if (key === 'tool_preferences' && typeof value === 'object') {
    const prefs = value as Record<string, number>;
    const entries = Object.entries(prefs)
      .sort((a, b) => b[1] - a[1]) // 按使用次数降序
      .slice(0, 5); // 只显示前 5 个

    if (entries.length === 0) return '暂无工具使用记录';

    const formatted = entries.map(([tool, count]) => `${tool}(${count})`).join(', ');
    const total = Object.keys(prefs).length;
    return total > 5 ? `${formatted} 等 ${total} 项` : formatted;
  }

  // 特殊处理 coding_style：编码风格偏好
  if (key === 'coding_style' && typeof value === 'object') {
    const style = value as Record<string, unknown>;
    const parts: string[] = [];
    if (style.indentation) parts.push(`缩进: ${style.indentation}`);
    if (style.quotes) parts.push(`引号: ${style.quotes}`);
    if (style.semicolons !== undefined) parts.push(`分号: ${style.semicolons ? '是' : '否'}`);
    return parts.length > 0 ? parts.join(', ') : '已学习编码风格';
  }

  // 数组：显示数量
  if (Array.isArray(value)) {
    return `${value.length} 项`;
  }

  // 其他对象：显示键数量
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `${keys.length} 项配置`;
  }

  // 其他类型：转字符串
  return String(value);
}

/**
 * 判断是否应该在用户界面隐藏该偏好项
 * 某些内部系统数据不应该展示给用户
 */
function shouldHidePreference(key: string): boolean {
  const hiddenKeys = [
    'tool_preferences', // 工具使用统计是内部数据
    // 可以添加其他需要隐藏的 key
  ];
  return hiddenKeys.includes(key);
}

// ----------------------------------------------------------------------------
// Memory Management (new for Phase 2)
// ----------------------------------------------------------------------------

/**
 * 从 VectorStore 和 Database 获取所有记忆条目
 * 映射到 MemoryItem 格式
 */
async function handleListMemories(payload: { category?: MemoryCategory }): Promise<MemoryItem[]> {
  const db = getDatabase();
  const vectorStore = getVectorStore();

  const memories: MemoryItem[] = [];

  // 从项目知识库获取
  const projectKnowledge = db.getAllProjectKnowledge();
  for (const pk of projectKnowledge) {
    // 映射旧分类到新分类
    const category = mapToNewCategory(pk.source);
    if (payload.category && category !== payload.category) continue;

    memories.push({
      id: `pk_${pk.id}`,
      content: formatValueForDisplay(pk.key, pk.value),
      category,
      source: pk.source === 'explicit' ? 'explicit' : 'learned',
      confidence: pk.confidence,
      createdAt: pk.createdAt,
      updatedAt: pk.updatedAt || pk.createdAt,
      projectPath: pk.projectPath,
    });
  }

  // 从用户偏好获取
  const prefs = db.getAllPreferences();
  for (const [key, value] of Object.entries(prefs)) {
    if (payload.category && payload.category !== 'preference') continue;

    // 跳过应该隐藏的内部系统数据
    if (shouldHidePreference(key)) continue;

    memories.push({
      id: `pref_${key}`,
      content: formatValueForDisplay(key, value),
      category: 'preference',
      source: 'explicit',
      confidence: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  // 从向量存储获取知识条目
  const stats = vectorStore.getStats();
  if (stats.bySource['knowledge']) {
    // VectorStore 的知识条目需要单独处理
    // 目前 VectorStore 没有直接列出所有文档的方法
    // 这里只返回已有的 projectKnowledge 数据
  }

  // 按更新时间排序
  memories.sort((a, b) => b.updatedAt - a.updatedAt);

  return memories;
}

/**
 * 更新记忆条目
 */
async function handleUpdateMemory(payload: { id: string; content: string }): Promise<boolean> {
  const db = getDatabase();

  if (payload.id.startsWith('pk_')) {
    const realId = payload.id.replace('pk_', '');
    return db.updateProjectKnowledge(realId, payload.content);
  }

  if (payload.id.startsWith('pref_')) {
    const key = payload.id.replace('pref_', '');
    db.setPreference(key, payload.content);
    return true;
  }

  return false;
}

/**
 * 删除记忆条目
 */
async function handleDeleteMemory(payload: { id: string }): Promise<boolean> {
  const db = getDatabase();

  if (payload.id.startsWith('pk_')) {
    const realId = payload.id.replace('pk_', '');
    return db.deleteProjectKnowledge(realId);
  }

  if (payload.id.startsWith('pref_')) {
    const key = payload.id.replace('pref_', '');
    db.deletePreference(key);
    return true;
  }

  return false;
}

/**
 * 按分类删除所有记忆
 */
async function handleDeleteByCategory(payload: { category: MemoryCategory }): Promise<number> {
  const db = getDatabase();
  let deleted = 0;

  if (payload.category === 'preference') {
    const prefs = db.getAllPreferences();
    for (const key of Object.keys(prefs)) {
      db.deletePreference(key);
      deleted++;
    }
  } else {
    // 删除对应分类的项目知识
    deleted = db.deleteProjectKnowledgeBySource(mapFromNewCategory(payload.category));
  }

  return deleted;
}

/**
 * 导出所有记忆
 */
async function handleExportMemories(): Promise<MemoryExport> {
  const items = await handleListMemories({});

  return {
    version: 1,
    exportedAt: Date.now(),
    items,
  };
}

/**
 * 导入记忆
 */
async function handleImportMemories(payload: { data: MemoryExport }): Promise<{ imported: number; skipped: number }> {
  const db = getDatabase();
  let imported = 0;
  let skipped = 0;

  for (const item of payload.data.items) {
    try {
      if (item.category === 'preference') {
        const key = item.content.split(':')[0]?.trim();
        const value = item.content.split(':').slice(1).join(':').trim();
        if (key) {
          db.setPreference(key, value);
          imported++;
        }
      } else {
        db.saveProjectKnowledge(
          item.projectPath || 'global',
          `memory_${Date.now()}`,
          item.content,
          item.source,
          item.confidence
        );
        imported++;
      }
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 获取记忆统计
 */
async function handleGetMemoryStats(): Promise<MemoryStats> {
  const items = await handleListMemories({});
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const byCategory: Record<MemoryCategory, number> = {
    about_me: 0,
    preference: 0,
    frequent_info: 0,
    learned: 0,
  };

  let learnedCount = 0;
  let explicitCount = 0;
  let recentlyAdded = 0;

  for (const item of items) {
    byCategory[item.category]++;
    if (item.source === 'learned') learnedCount++;
    else explicitCount++;
    if (item.createdAt > weekAgo) recentlyAdded++;
  }

  return {
    total: items.length,
    byCategory,
    recentlyAdded,
    learnedCount,
    explicitCount,
  };
}

// ----------------------------------------------------------------------------
// Category Mapping Helpers
// ----------------------------------------------------------------------------

/**
 * 映射旧分类到新分类
 */
function mapToNewCategory(source: string): MemoryCategory {
  switch (source) {
    case 'preference':
      return 'preference';
    case 'pattern':
    case 'decision':
    case 'insight':
    case 'error_solution':
    case 'learned':
      return 'learned';
    case 'context':
      return 'frequent_info';
    case 'about_me':
      return 'about_me';
    default:
      return 'learned';
  }
}

/**
 * 映射新分类到旧分类（用于数据库查询）
 */
function mapFromNewCategory(category: MemoryCategory): string {
  switch (category) {
    case 'about_me':
      return 'about_me';
    case 'preference':
      return 'preference';
    case 'frequent_info':
      return 'context';
    case 'learned':
      return 'learned';
    default:
      return 'learned';
  }
}

// ----------------------------------------------------------------------------
// Original Handlers
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
        // Phase 2: Memory Management
        case 'list':
          data = await handleListMemories(payload as { category?: MemoryCategory });
          break;
        case 'update':
          data = await handleUpdateMemory(payload as { id: string; content: string });
          break;
        case 'delete':
          data = await handleDeleteMemory(payload as { id: string });
          break;
        case 'deleteByCategory':
          data = await handleDeleteByCategory(payload as { category: MemoryCategory });
          break;
        case 'export':
          data = await handleExportMemories();
          break;
        case 'import':
          data = await handleImportMemories(payload as { data: MemoryExport });
          break;
        case 'getMemoryStats':
          data = await handleGetMemoryStats();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      logger.error('Memory IPC error:', error);
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Simple Memory Management Channel ==========
  // For frontend use - simpler API than domain-based
  ipcMain.handle(IPC_CHANNELS.MEMORY, async (_, request: { action: string; [key: string]: unknown }) => {
    try {
      let data: unknown;

      switch (request.action) {
        case 'list':
          data = await handleListMemories({ category: request.category as MemoryCategory | undefined });
          break;
        case 'update':
          data = await handleUpdateMemory({ id: request.id as string, content: request.content as string });
          break;
        case 'delete':
          data = await handleDeleteMemory({ id: request.id as string });
          break;
        case 'deleteByCategory':
          data = { deleted: await handleDeleteByCategory({ category: request.category as MemoryCategory }) };
          break;
        case 'export':
          data = await handleExportMemories();
          break;
        case 'import':
          data = await handleImportMemories({ data: request.data as MemoryExport });
          break;
        case 'getStats':
          data = await handleGetMemoryStats();
          break;
        default:
          return { success: false, error: `Unknown action: ${request.action}` };
      }

      return { success: true, data };
    } catch (error) {
      logger.error('Memory IPC error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
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
