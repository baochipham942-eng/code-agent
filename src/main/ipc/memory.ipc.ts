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
import type {
  MemoryItem,
  MemoryCategory,
  MemoryStats as MemoryStatsNew,
  MemoryExport,
} from '../../shared/types/memory';
import { getSessionManager, getDatabase } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getVectorStore } from '../memory/vectorStore';
import { handleMemoryConfirmResponse } from '../memory/memoryNotification';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryIPC');

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
// Learning Insights Handler - 学习图谱数据
// ----------------------------------------------------------------------------

interface ToolPreference {
  name: string;
  count: number;
  percentage: number;
}

interface CodingStyle {
  semicolons: boolean;
  indent: string;
  quotes: string;
}

interface EvolutionPattern {
  name: string;
  type: string;
  context: string;
  pattern: string;
  solution: string;
  confidence: number;
  occurrences: number;
  tags: string[];
}

interface LearningInsights {
  toolPreferences: ToolPreference[];
  codingStyle: CodingStyle | null;
  evolutionPatterns: EvolutionPattern[];
  totalToolUsage: number;
  topTools: string[];
}

/**
 * 获取学习洞察数据（用于知识图谱可视化）
 */
async function handleGetLearningInsights(): Promise<LearningInsights> {
  const db = getDatabase();
  const prefs = db.getAllPreferences();

  // 1. 工具使用偏好
  const toolPrefsRaw = prefs.tool_preferences as Record<string, number> | undefined;
  let toolPreferences: ToolPreference[] = [];
  let totalToolUsage = 0;
  let topTools: string[] = [];

  if (toolPrefsRaw && typeof toolPrefsRaw === 'object') {
    const entries = Object.entries(toolPrefsRaw);
    totalToolUsage = entries.reduce((sum, [_, count]) => sum + (count as number), 0);

    toolPreferences = entries
      .map(([name, count]) => ({
        name,
        count: count as number,
        percentage: totalToolUsage > 0 ? ((count as number) / totalToolUsage) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    topTools = toolPreferences.slice(0, 5).map(t => t.name);
  }

  // 2. 代码风格
  const codingStyleRaw = prefs.coding_style as CodingStyle | undefined;
  let codingStyle: CodingStyle | null = null;

  if (codingStyleRaw && typeof codingStyleRaw === 'object') {
    codingStyle = {
      semicolons: codingStyleRaw.semicolons ?? false,
      indent: codingStyleRaw.indent ?? '2spaces',
      quotes: codingStyleRaw.quotes ?? 'single',
    };
  }

  // 3. 演化模式（成功模式）
  const evolutionPatternsRaw = prefs.evolution_patterns as EvolutionPattern[] | undefined;
  let evolutionPatterns: EvolutionPattern[] = [];

  if (Array.isArray(evolutionPatternsRaw)) {
    evolutionPatterns = evolutionPatternsRaw.map(p => ({
      name: p.name || '未命名模式',
      type: p.type || 'success',
      context: p.context || '',
      pattern: p.pattern || '',
      solution: p.solution || '',
      confidence: p.confidence ?? 0.5,
      occurrences: p.occurrences ?? 1,
      tags: Array.isArray(p.tags) ? p.tags : [],
    }));
  }

  return {
    toolPreferences,
    codingStyle,
    evolutionPatterns,
    totalToolUsage,
    topTools,
  };
}

// ----------------------------------------------------------------------------
// Phase 2 Handlers - Memory Tab UI
// ----------------------------------------------------------------------------

/**
 * 映射旧分类到新分类
 */
function mapToNewCategory(source: string): MemoryCategory {
  switch (source) {
    case 'explicit':
    case 'user_defined':
      return 'preference';
    case 'learned':
    case 'auto_learned':
      return 'learned';
    case 'inferred':
      return 'frequent_info';
    default:
      return 'learned';
  }
}

/**
 * 映射新分类到旧分类
 */
function mapFromNewCategory(category: MemoryCategory): string {
  switch (category) {
    case 'about_me':
      return 'explicit';
    case 'preference':
      return 'explicit';
    case 'frequent_info':
      return 'inferred';
    case 'learned':
      return 'learned';
    default:
      return 'learned';
  }
}

/**
 * 从 VectorStore 和 Database 获取所有记忆条目
 * 映射到 MemoryItem 格式
 */
async function handleListMemoriesNew(payload: { category?: MemoryCategory }): Promise<MemoryItem[]> {
  const db = getDatabase();

  const memories: MemoryItem[] = [];

  // 从项目知识库获取
  const projectKnowledge = db.getAllProjectKnowledge();
  for (const pk of projectKnowledge) {
    // 映射旧分类到新分类
    const category = mapToNewCategory(pk.source);
    if (payload.category && category !== payload.category) continue;

    memories.push({
      id: `pk_${pk.id}`,
      content: typeof pk.value === 'string' ? pk.value : JSON.stringify(pk.value),
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

    memories.push({
      id: `pref_${key}`,
      content: `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      category: 'preference',
      source: 'explicit',
      confidence: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  // 按更新时间排序
  memories.sort((a, b) => b.updatedAt - a.updatedAt);

  return memories;
}

/**
 * 添加记忆条目
 */
async function handleAddMemory(payload: { item: Partial<MemoryItem> }): Promise<MemoryItem> {
  const db = getDatabase();
  const item = payload.item;

  const id = `pk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();

  db.saveProjectKnowledge(
    item.projectPath || 'global',
    `memory_${now}`,
    item.content || '',
    item.source === 'explicit' ? 'explicit' : 'learned',
    item.confidence ?? 1.0
  );

  return {
    id,
    content: item.content || '',
    category: item.category || 'learned',
    source: item.source || 'explicit',
    confidence: item.confidence ?? 1.0,
    createdAt: now,
    updatedAt: now,
    projectPath: item.projectPath,
    tags: item.tags,
  };
}

/**
 * 更新记忆条目
 */
async function handleUpdateMemoryNew(payload: { id: string; content: string }): Promise<boolean> {
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
async function handleDeleteMemoryNew(payload: { id: string }): Promise<boolean> {
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
  const items = await handleListMemoriesNew({});

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
 * 获取记忆统计（新格式）
 */
async function handleGetMemoryStatsNew(): Promise<MemoryStatsNew> {
  const items = await handleListMemoriesNew({});
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
    if (item.source === 'learned') {
      learnedCount++;
    } else {
      explicitCount++;
    }
    if (item.createdAt >= weekAgo) {
      recentlyAdded++;
    }
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
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Memory 相关 IPC handlers
 */
export function registerMemoryHandlers(ipcMain: IpcMain): void {
  // ========== Phase 2 Memory Tab Handler ==========
  ipcMain.handle(IPC_CHANNELS.MEMORY, async (_, payload: {
    action: string;
    category?: MemoryCategory;
    id?: string;
    content?: string;
    data?: MemoryExport;
    item?: Partial<MemoryItem>;
  }) => {
    try {
      switch (payload.action) {
        case 'list':
          return { success: true, data: await handleListMemoriesNew({ category: payload.category }) };
        case 'add':
          if (!payload.item) return { success: false, error: 'Missing item' };
          return { success: true, data: await handleAddMemory({ item: payload.item }) };
        case 'update':
          if (!payload.id || !payload.content) return { success: false, error: 'Missing id or content' };
          const updated = await handleUpdateMemoryNew({ id: payload.id, content: payload.content });
          return { success: updated, error: updated ? undefined : 'Update failed' };
        case 'delete':
          if (!payload.id) return { success: false, error: 'Missing id' };
          const deleted = await handleDeleteMemoryNew({ id: payload.id });
          return { success: deleted, error: deleted ? undefined : 'Delete failed' };
        case 'deleteByCategory':
          if (!payload.category) return { success: false, error: 'Missing category' };
          const deletedCount = await handleDeleteByCategory({ category: payload.category });
          return { success: true, data: { deleted: deletedCount } };
        case 'export':
          return { success: true, data: await handleExportMemories() };
        case 'import':
          if (!payload.data) return { success: false, error: 'Missing data' };
          return { success: true, data: await handleImportMemories({ data: payload.data }) };
        case 'getStats':
          return { success: true, data: await handleGetMemoryStatsNew() };
        case 'getLearningInsights':
          return { success: true, data: await handleGetLearningInsights() };
        default:
          return { success: false, error: `Unknown action: ${payload.action}` };
      }
    } catch (error) {
      logger.error('Memory action failed', { action: payload.action, error });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ========== Phase 3 Memory Confirm Response Handler ==========
  ipcMain.handle(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, async (_, payload: { id: string; confirmed: boolean }) => {
    try {
      handleMemoryConfirmResponse(payload.id, payload.confirmed);
    } catch (error) {
      logger.error('Memory confirm response failed', error);
    }
  });

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
