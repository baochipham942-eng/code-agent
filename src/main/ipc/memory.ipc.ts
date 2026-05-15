// ============================================================================
// Memory IPC Handlers - memory:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getSessionManager, getDatabase } from '../services';
import type { MemoryRecord as StoredMemoryRecord } from '../services/core/repositories';
import type { MemoryItem, MemoryCategory, MemoryExport, MemoryStats } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import {
  listMemoryFiles,
  readMemoryFile,
  deleteMemoryFile,
  getLightMemoryStats,
  getLightMemoryHealth,
  rebuildLightMemoryIndex,
} from '../lightMemory/lightMemoryIpc';
import { listMemoryInjectionTraces, type MemoryInjectionTrace } from '../memory/memoryInjectionTrace';
import {
  buildActiveMemoryEntryFromInbox,
  applyImportMemoryBundleV2,
  createMemoryMirrorRecord,
  dryRunImportMemoryBundleV2,
  exportMemoryBundleV2,
  lightMemoryFileToEntry,
  listUnifiedMemoryEntries,
  packMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  storedMemoryToEntry,
  writeActiveEntryToLightMemory,
} from '../memory/memoryEntryRuntime';
import {
  KNOWLEDGE_INBOX_DECISION_CATEGORY,
  hashInboxContent,
  parseKnowledgeInboxDecision,
  shouldSuppressMemoryByInboxDecision,
  type KnowledgeInboxDecisionRecord,
  type KnowledgeInboxDecisionValue,
} from '../memory/knowledgeInboxDecision';
import type {
  MemoryEntry,
  MemoryExportV2Bundle,
  MemoryImportV2ApplyRequest,
  MemoryMirrorRebuildResult,
  MemoryPackRequest,
} from '../../shared/contract/memory';

const logger = createLogger('MemoryIPC');

interface MemoryAuditRequest {
  projectPath?: string | null;
  sessionId?: string | null;
  limit?: number;
}

interface MemoryInboxResolveRequest {
  candidateId?: string;
  decision?: KnowledgeInboxDecisionValue;
  content?: string;
  title?: string;
  source?: string;
  reason?: string;
  kind?: string;
  projectPath?: string | null;
  sessionId?: string | null;
}

interface SerializedAuditMemory {
  id: string;
  type: StoredMemoryRecord['type'];
  category: string;
  content: string;
  summary?: string;
  source: StoredMemoryRecord['source'];
  projectPath: string | null;
  sessionId: string | null;
  confidence: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  metadata: Record<string, unknown>;
}

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
    // 处理 indent/indentation 字段
    const indent = style.indent || style.indentation;
    if (indent) {
      const indentLabel = indent === '2spaces' ? '2 空格' : indent === '4spaces' ? '4 空格' : indent === 'tab' ? 'Tab' : String(indent);
      parts.push(`缩进: ${indentLabel}`);
    }
    // 处理 quotes 字段
    if (style.quotes) {
      const quotesLabel = style.quotes === 'single' ? '单引号' : style.quotes === 'double' ? '双引号' : String(style.quotes);
      parts.push(`引号: ${quotesLabel}`);
    }
    // 处理 semicolons 字段
    if (style.semicolons !== undefined) {
      parts.push(`分号: ${style.semicolons ? '使用' : '不使用'}`);
    }
    return parts.length > 0 ? `编码风格: ${parts.join(', ')}` : '已学习编码风格';
  }

  // 数组：显示数量
  if (Array.isArray(value)) {
    return `${value.length} 项`;
  }

  // 特殊处理 pattern 类型的对象（学到的经验）
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 如果是 pattern 对象，显示 name
    if (obj.name && typeof obj.name === 'string') {
      const typeLabel = obj.type === 'success' ? '✓' : obj.type === 'failure' ? '✗' : '';
      return typeLabel ? `${typeLabel} ${obj.name}` : obj.name;
    }
    // 其他对象：显示键数量
    const keys = Object.keys(obj);
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
    'tool_preferences',    // 工具使用统计是内部数据
    'evolution_patterns',  // 进化模式是内部数据
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

function serializeAuditMemory(memory: StoredMemoryRecord): SerializedAuditMemory {
  return {
    id: memory.id,
    type: memory.type,
    category: memory.category,
    content: memory.content,
    summary: memory.summary,
    source: memory.source,
    projectPath: memory.projectPath ?? null,
    sessionId: memory.sessionId ?? null,
    confidence: memory.confidence,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastAccessedAt: memory.lastAccessedAt ?? null,
    metadata: memory.metadata ?? {},
  };
}

function compactOneLine(value: string | undefined, limit: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeNullableText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function categoryForInboxKind(kind: string | undefined): string {
  switch (kind) {
    case '候选项目知识':
      return 'flush_decision';
    case '失败复盘':
      return 'error_solution';
    case '可沉淀经验':
      return 'pattern';
    case '会话结论':
    default:
      return 'user_requirement';
  }
}

function isAuditableMemory(memory: StoredMemoryRecord): boolean {
  return memory.type !== 'desktop_activity';
}

function sortSeedCandidates(a: StoredMemoryRecord, b: StoredMemoryRecord): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return b.updatedAt - a.updatedAt;
}

async function handleMemoryAudit(payload: MemoryAuditRequest): Promise<{
  projectPath: string | null;
  sessionId: string | null;
  lightFiles: Awaited<ReturnType<typeof listMemoryFiles>>;
  lightStats: Awaited<ReturnType<typeof getLightMemoryStats>>;
  databaseMemories: SerializedAuditMemory[];
  seedCandidates: SerializedAuditMemory[];
  inboxDecisions: KnowledgeInboxDecisionRecord[];
  injectionTraces: MemoryInjectionTrace[];
  memoryEntries: MemoryEntry[];
}> {
  const projectPath = payload.projectPath?.trim() || null;
  const sessionId = payload.sessionId?.trim() || null;
  const limit = Math.max(1, Math.min(payload.limit ?? 80, 200));
  const [lightFiles, lightStats] = await Promise.all([
    listMemoryFiles(),
    getLightMemoryStats(),
  ]);

  let databaseMemories: StoredMemoryRecord[] = [];
  let seedCandidates: StoredMemoryRecord[] = [];
  let inboxDecisions: KnowledgeInboxDecisionRecord[] = [];
  let memoryEntries: MemoryEntry[] = [];

  try {
    const db = getDatabase();
    databaseMemories = db.listMemories({
      limit,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).filter(isAuditableMemory);

    const decisionRecords = db.listMemories({
      category: KNOWLEDGE_INBOX_DECISION_CATEGORY,
      ...(projectPath ? { projectPath } : {}),
      limit: 100,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }) || [];
    inboxDecisions = decisionRecords
      .map(parseKnowledgeInboxDecision)
      .filter((decision): decision is KnowledgeInboxDecisionRecord => Boolean(decision));

    seedCandidates = db.listMemories({
      ...(projectPath ? { projectPath } : {}),
      limit: 30,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    })
      .filter(isAuditableMemory)
      .filter((memory) => !shouldSuppressMemoryByInboxDecision(memory, inboxDecisions))
      .sort(sortSeedCandidates)
      .slice(0, 10);
    const lightEntryIds = new Set(lightFiles.map((file) => file.entryId || `light:${file.filename}`));
    memoryEntries = [
      ...lightFiles.map(lightMemoryFileToEntry),
      ...databaseMemories
        .map(storedMemoryToEntry)
        .filter((entry) => !(entry.source.sourceOfTruth === 'light_file' && lightEntryIds.has(entry.id))),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    logger.warn('Memory audit database read skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    memoryEntries = (await listUnifiedMemoryEntries()).entries;
  }

  return {
    projectPath,
    sessionId,
    lightFiles,
    lightStats,
    databaseMemories: databaseMemories.map(serializeAuditMemory),
    seedCandidates: seedCandidates.map(serializeAuditMemory),
    inboxDecisions,
    injectionTraces: listMemoryInjectionTraces({ sessionId, limit }),
    memoryEntries,
  };
}

async function handleListMemoryEntries(): Promise<Awaited<ReturnType<typeof listUnifiedMemoryEntries>>> {
  try {
    return await listUnifiedMemoryEntries(getDatabase());
  } catch (error) {
    logger.warn('Memory entry DB mirror read skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return listUnifiedMemoryEntries();
  }
}

async function handleRebuildMemoryMirror(): Promise<MemoryMirrorRebuildResult> {
  return rebuildMemoryMirrorFromLightFiles(getDatabase());
}

async function handleMemoryPack(payload: MemoryPackRequest): Promise<Awaited<ReturnType<typeof packMemoryEntries>>> {
  try {
    return await packMemoryEntries(payload || {}, getDatabase());
  } catch (error) {
    logger.warn('Memory pack DB read skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return packMemoryEntries(payload || {});
  }
}

async function handleMemoryExportV2(): Promise<MemoryExportV2Bundle> {
  try {
    return await exportMemoryBundleV2(getDatabase());
  } catch (error) {
    logger.warn('Memory export v2 DB read skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return exportMemoryBundleV2();
  }
}

async function handleMemoryImportV2DryRun(payload: { bundle?: MemoryExportV2Bundle }): Promise<Awaited<ReturnType<typeof dryRunImportMemoryBundleV2>>> {
  if (!payload?.bundle || payload.bundle.schemaVersion !== 2) {
    throw new Error('memory import v2 requires a schemaVersion 2 bundle');
  }
  try {
    return await dryRunImportMemoryBundleV2(payload.bundle, getDatabase());
  } catch (error) {
    logger.warn('Memory import v2 dry-run DB read skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return dryRunImportMemoryBundleV2(payload.bundle);
  }
}

async function handleMemoryImportV2Apply(payload: MemoryImportV2ApplyRequest): Promise<Awaited<ReturnType<typeof applyImportMemoryBundleV2>>> {
  if (!payload?.bundle || payload.bundle.schemaVersion !== 2) {
    throw new Error('memory import v2 apply requires a schemaVersion 2 bundle');
  }
  return applyImportMemoryBundleV2(payload.bundle, getDatabase(), {
    allowConflicts: payload.allowConflicts,
  });
}

async function handleMemoryInboxResolve(payload: MemoryInboxResolveRequest): Promise<{
  candidateId: string;
  decision: KnowledgeInboxDecisionValue;
  contentHash: string;
  memory: SerializedAuditMemory | null;
  decisionMemoryId: string;
}> {
  const candidateId = payload.candidateId?.trim();
  if (!candidateId) {
    throw new Error('candidateId is required');
  }
  const decision = payload.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('decision must be approve or reject');
  }

  const content = (payload.content || '').trim();
  if (decision === 'approve' && !content) {
    throw new Error('content is required when approving an inbox item');
  }

  const db = getDatabase();
  const projectPath = normalizeNullableText(payload.projectPath);
  const sessionId = normalizeNullableText(payload.sessionId);
  const title = compactOneLine(payload.title || content || candidateId, 180);
  const decidedAt = Date.now();
  const contentHash = hashInboxContent(content);
  const decisionMetadata = {
    knowledgeInbox: {
      candidateId,
      decision,
      contentHash,
      title,
      kind: payload.kind || '',
      source: payload.source || '',
      reason: payload.reason || '',
      decidedAt,
    },
  };

  let approvedMemory: StoredMemoryRecord | null = null;
  if (decision === 'approve') {
    const activeEntry = buildActiveMemoryEntryFromInbox({
      candidateId,
      content,
      title,
      source: payload.source || '',
      reason: payload.reason || '',
      kind: payload.kind,
      projectPath,
      sessionId,
      contentHash,
    });
    const writtenFile = await writeActiveEntryToLightMemory(activeEntry);
    const mirroredEntry: MemoryEntry = {
      ...activeEntry,
      source: {
        ...activeEntry.source,
        filePath: writtenFile.filename,
        label: `~/.code-agent/memory/${writtenFile.filename}`,
      },
      updatedAt: Date.parse(writtenFile.updatedAt) || activeEntry.updatedAt,
    };
    approvedMemory = createMemoryMirrorRecord(db, mirroredEntry, {
      category: categoryForInboxKind(payload.kind),
      metadata: decisionMetadata,
    });
  }

  const decisionMemory = db.createMemory({
    type: 'desktop_activity',
    category: KNOWLEDGE_INBOX_DECISION_CATEGORY,
    content: `${decision === 'approve' ? 'Approved' : 'Rejected'} Knowledge Inbox candidate: ${title || candidateId}`,
    summary: `${decision === 'approve' ? '采纳' : '忽略'}: ${title || candidateId}`,
    source: 'user_defined',
    projectPath,
    sessionId,
    confidence: 1,
    metadata: {
      knowledgeInbox: {
        ...decisionMetadata.knowledgeInbox,
        memoryId: approvedMemory?.id ?? null,
      },
    },
  });

  return {
    candidateId,
    decision,
    contentHash,
    memory: approvedMemory ? serializeAuditMemory(approvedMemory) : null,
    decisionMemoryId: decisionMemory.id,
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

async function handleGetContext(_payload: { query: string }): Promise<unknown> {
  // Memory service removed — return empty results
  return {
    ragContext: '',
    projectKnowledge: [],
    relevantCode: [],
    relevantConversations: [],
  };
}

async function handleSearchCode(_payload: { query: string; topK?: number }): Promise<unknown> {
  // Memory service removed — return empty results
  return [];
}

async function handleSearchConversations(_payload: { query: string; topK?: number }): Promise<unknown> {
  // Memory service removed — return empty results
  return [];
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
        case 'lightList':
          data = await listMemoryFiles();
          break;
        case 'lightRead':
          data = await readMemoryFile((payload as { filename?: string })?.filename || '');
          break;
        case 'lightDelete':
          data = await deleteMemoryFile((payload as { filename?: string })?.filename || '');
          break;
        case 'lightStats':
          data = await getLightMemoryStats();
          break;
        case 'lightHealth':
          data = await getLightMemoryHealth();
          break;
        case 'lightRebuildIndex':
          data = await rebuildLightMemoryIndex();
          break;
        case 'memoryAudit':
          data = await handleMemoryAudit(payload as MemoryAuditRequest);
          break;
        case 'memoryInboxResolve':
          data = await handleMemoryInboxResolve(payload as MemoryInboxResolveRequest);
          break;
        case 'memoryEntries':
          data = await handleListMemoryEntries();
          break;
        case 'memoryRebuildMirror':
          data = await handleRebuildMemoryMirror();
          break;
        case 'memoryPack':
          data = await handleMemoryPack(payload as MemoryPackRequest);
          break;
        case 'memoryExportV2':
          data = await handleMemoryExportV2();
          break;
        case 'memoryImportV2DryRun':
          data = await handleMemoryImportV2DryRun(payload as { bundle?: MemoryExportV2Bundle });
          break;
        case 'memoryImportV2Apply':
          data = await handleMemoryImportV2Apply(payload as MemoryImportV2ApplyRequest);
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
        // Light Memory actions
        case 'lightList':
          data = await listMemoryFiles();
          break;
        case 'lightRead':
          data = await readMemoryFile(request.filename as string);
          break;
        case 'lightDelete':
          data = await deleteMemoryFile(request.filename as string);
          break;
        case 'lightStats':
          data = await getLightMemoryStats();
          break;
        case 'lightHealth':
          data = await getLightMemoryHealth();
          break;
        case 'lightRebuildIndex':
          data = await rebuildLightMemoryIndex();
          break;
        case 'memoryAudit':
          data = await handleMemoryAudit(request as MemoryAuditRequest);
          break;
        case 'memoryInboxResolve':
          data = await handleMemoryInboxResolve(request as MemoryInboxResolveRequest);
          break;
        case 'memoryEntries':
          data = await handleListMemoryEntries();
          break;
        case 'memoryRebuildMirror':
          data = await handleRebuildMemoryMirror();
          break;
        case 'memoryPack':
          data = await handleMemoryPack(request as MemoryPackRequest);
          break;
        case 'memoryExportV2':
          data = await handleMemoryExportV2();
          break;
        case 'memoryImportV2DryRun':
          data = await handleMemoryImportV2DryRun(request as { bundle?: MemoryExportV2Bundle });
          break;
        case 'memoryImportV2Apply':
          data = await handleMemoryImportV2Apply(request as unknown as MemoryImportV2ApplyRequest);
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

  // Memory confirm response handler (Phase 3) — old notification system removed
  ipcMain.handle(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, async (_: unknown, _payload: { id: string; confirmed: boolean }) => {
    // no-op: memoryNotification removed with old memory system
  });
}
