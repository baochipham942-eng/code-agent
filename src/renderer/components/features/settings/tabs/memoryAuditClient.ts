// ============================================================================
// memoryAuditClient - 设置 → 记忆 诊断/收件箱共用的 memory IPC 与纯函数层
// ============================================================================
//
// 2026-08-02 从 features/knowledge/KnowledgeMemoryPanel.tsx 整体搬入（整窗页壳子退役，
// Injection Trace / Light Memory 健康进诊断区，Knowledge Inbox 独立成 SettingsSection）。
// 只搬位置，逻辑未改。

import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { isWebMode } from '../../../../utils/platform';
import { zh, type Translations } from '../../../../i18n';

export interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  updatedAt: string;
}

export interface LightMemoryStats {
  totalFiles: number;
  byType: Record<string, number>;
  sessionStats: {
    activeDays: string[];
    totalSessions: number;
    recentSessionDepths: number[];
    modelUsage: Record<string, number>;
  } | null;
  recentConversations: string[];
}

export interface LightMemoryHealthReport {
  totalFiles: number;
  indexExists: boolean;
  indexLineCount: number;
  indexTooLong: boolean;
  missingInIndex: string[];
  orphanInIndex: string[];
  invalidFrontmatter: Array<{ filename: string; reason: string }>;
  unreadableFiles: Array<{ filename: string; reason: string }>;
  duplicateNames: Array<{ value: string; filenames: string[] }>;
  duplicateDescriptions: Array<{ value: string; filenames: string[] }>;
}

export interface LightMemoryRebuildResult {
  indexPath: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: Array<{ filename: string; reason: string }>;
}

interface StoredMemory {
  id: string;
  type:
    | 'user_preference'
    | 'code_pattern'
    | 'project_knowledge'
    | 'conversation'
    | 'tool_usage'
    | 'desktop_activity'
    | 'workspace_activity';
  category: string;
  content: string;
  summary?: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath: string | null;
  sessionId: string | null;
  confidence: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  metadata: Record<string, unknown>;
}

export interface MemoryAuditPayload {
  projectPath: string | null;
  sessionId: string | null;
  lightFiles: LightMemoryFile[];
  lightStats: LightMemoryStats;
  databaseMemories: StoredMemory[];
  seedCandidates: StoredMemory[];
  inboxDecisions?: Array<{
    candidateId: string;
    decision: 'approve' | 'reject';
    contentHash: string;
    title: string;
    kind: string;
    source: string;
    reason: string;
    decidedAt: number;
    memoryId: string | null;
    decisionMemoryId: string;
  }>;
  injectionTraces?: MemoryInjectionTrace[];
}

export interface MemoryInjectionTrace {
  id: string;
  blockType: 'seed-memory' | 'memory_index' | 'memory_hint' | 'recent_conversations';
  trigger: string;
  chars: number;
  injected: boolean;
  source: string;
  count: number;
  timestamp: number;
  sessionId: string;
}

interface MemoryResponse<T> {
  success: boolean;
  data?: T;
  error?: string | { message?: string };
}

export interface InboxItem {
  id: string;
  contentHash: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  source: string;
  reason: string;
  updatedAt: number | null;
}

type InboxDecision = 'approve' | 'reject';

interface MemoryInboxResolvePayload {
  candidateId: string;
  decision: InboxDecision;
  content: string;
  title: string;
  source: string;
  reason: string;
  kind: InboxItem['kind'];
  projectPath?: string | null;
  sessionId?: string | null;
}

export type InboxStatus = 'approving' | 'rejecting' | 'approved' | 'rejected';

function isMemoryResponse<T>(value: unknown): value is MemoryResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

export async function invokeMemoryAudit(payload: {
  projectPath?: string | null;
  sessionId?: string | null;
}): Promise<MemoryAuditPayload> {
  const request = { action: 'memoryAudit' as const, ...payload };
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;

  if (commandResult !== undefined) {
    if (!isMemoryResponse<MemoryAuditPayload>(commandResult)) {
      return commandResult as MemoryAuditPayload;
    }
    if (commandResult.success && commandResult.data) {
      return commandResult.data;
    }
    if (!isWebMode()) {
      const error = commandResult.error;
      throw new Error(typeof error === 'string' ? error : error?.message || 'memoryAudit failed');
    }
  }

  return ipcService.invokeDomain<MemoryAuditPayload>(
    IPC_DOMAINS.MEMORY,
    'memoryAudit',
    payload,
  );
}

export async function invokeMemoryCommand<T>(
  action: 'lightHealth' | 'lightRebuildIndex',
  payload: Record<string, unknown> = {},
): Promise<T> {
  const request = { action, ...payload };
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;

  if (commandResult !== undefined) {
    if (!isMemoryResponse<T>(commandResult)) {
      return commandResult as T;
    }
    if (commandResult.success && commandResult.data !== undefined) {
      return commandResult.data;
    }
    if (!isWebMode()) {
      const error = commandResult.error;
      throw new Error(typeof error === 'string' ? error : error?.message || `${action} failed`);
    }
  }

  return ipcService.invokeDomain<T>(
    IPC_DOMAINS.MEMORY,
    action,
    payload,
  );
}

export async function invokeMemoryInboxResolve(payload: MemoryInboxResolvePayload): Promise<void> {
  const request = { action: 'memoryInboxResolve' as const, ...payload };
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;

  if (commandResult !== undefined) {
    if (!isMemoryResponse<unknown>(commandResult)) {
      return;
    }
    if (commandResult.success) {
      return;
    }
    if (!isWebMode()) {
      const error = commandResult.error;
      throw new Error(typeof error === 'string' ? error : error?.message || 'memoryInboxResolve failed');
    }
  }

  await ipcService.invokeDomain(
    IPC_DOMAINS.MEMORY,
    'memoryInboxResolve',
    payload,
  );
}

export function buildMemoryInboxResolvePayload(
  item: InboxItem,
  decision: InboxDecision,
  options: {
    content?: string;
    projectPath?: string | null;
    sessionId?: string | null;
  } = {},
): MemoryInboxResolvePayload {
  return {
    candidateId: item.id,
    decision,
    content: options.content ?? item.content,
    title: item.title,
    source: item.source,
    reason: item.reason,
    kind: item.kind,
    projectPath: options.projectPath ?? null,
    sessionId: options.sessionId ?? null,
  };
}

function compactText(value: string | undefined, limit = 180): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

export function hashInboxContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseRecentTitle(line: string): string | null {
  const match = line.match(/^- \*\*.+?\*\*: "(.+?)"/);
  return match?.[1] ?? null;
}

function sourceLabelForStored(memory: StoredMemory, t: Translations = zh): string {
  const sourceMap: Record<StoredMemory['source'], string> = {
    auto_learned: t.knowledgeMemory.sourceAutoLearned,
    user_defined: t.knowledgeMemory.sourceUserDefined,
    session_extracted: t.knowledgeMemory.sourceSessionExtracted,
  };
  const project = memory.projectPath ? ` · ${memory.projectPath}` : '';
  const session = memory.sessionId ? ` · session ${memory.sessionId}` : '';
  return `${sourceMap[memory.source]}${project}${session}`;
}

export function buildInboxItems(data: MemoryAuditPayload, t: Translations = zh): InboxItem[] {
  const resolvedCandidateIds = new Set((data.inboxDecisions ?? []).map((decision) => decision.candidateId));
  const resolvedContentHashes = new Set((data.inboxDecisions ?? []).map((decision) => decision.contentHash).filter(Boolean));
  const isResolvedInboxMemory = (memory: StoredMemory): boolean => {
    const value = memory.metadata?.knowledgeInbox;
    if (!value || typeof value !== 'object') return false;
    const decision = (value as Record<string, unknown>).decision;
    return decision === 'approve' || decision === 'reject';
  };

  const fromSessionExtracted = data.databaseMemories
    .filter((memory) => memory.source === 'session_extracted' && !isResolvedInboxMemory(memory))
    .slice(0, 8)
    .map((memory): InboxItem => ({
      id: `flush:${memory.id}`,
      contentHash: hashInboxContent(memory.content),
      kind: memory.category === 'flush_decision' ? t.knowledgeMemory.kindProjectKnowledgeCandidate : t.knowledgeMemory.kindConversationOutcome,
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || t.knowledgeMemory.emptyPlaceholder,
      content: memory.content,
      source: sourceLabelForStored(memory, t),
      reason: memory.category === 'flush_decision'
        ? t.knowledgeMemory.inboxReasonFlushDecision
        : t.knowledgeMemory.inboxReasonUserRequirement,
      updatedAt: memory.updatedAt || memory.createdAt || null,
    }));

  const fromRecentConversations = data.lightStats.recentConversations.slice(0, 6).map((line, index): InboxItem => ({
    id: `conversation:${index}`,
    contentHash: hashInboxContent(line.replace(/^- /, '').trim()),
    kind: t.knowledgeMemory.kindConversationOutcome,
    title: parseRecentTitle(line) || t.knowledgeMemory.recentSessionTitle.replace('{index}', String(index + 1)),
    summary: compactText(line.replace(/^- /, ''), 180) || t.knowledgeMemory.emptyPlaceholder,
    content: line.replace(/^- /, '').trim(),
    source: '~/.code-agent/memory/recent-conversations.md',
    reason: t.knowledgeMemory.inboxReasonRecentConversation,
    updatedAt: null,
  }));

  const fromFailurePatterns = data.databaseMemories
    .filter((memory) => !isResolvedInboxMemory(memory))
    .filter((memory) => /error|failure|solution|pattern|复盘|失败/i.test(`${memory.category} ${memory.content}`))
    .slice(0, 6)
    .map((memory): InboxItem => ({
      id: `pattern:${memory.id}`,
      contentHash: hashInboxContent(memory.content),
      kind: memory.category.includes('error') ? t.knowledgeMemory.kindFailureRetro : t.knowledgeMemory.kindReusableExperience,
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || t.knowledgeMemory.emptyPlaceholder,
      content: memory.content,
      source: sourceLabelForStored(memory, t),
      reason: t.knowledgeMemory.inboxReasonExperiencePattern,
      updatedAt: memory.updatedAt || memory.createdAt || null,
    }));

  const seen = new Set<string>();
  return [...fromSessionExtracted, ...fromRecentConversations, ...fromFailurePatterns]
    .filter((item) => {
      const key = `${item.kind}:${item.title}:${item.summary}`;
      if (seen.has(key)) return false;
      if (resolvedCandidateIds.has(item.id)) return false;
      if (resolvedContentHashes.has(item.contentHash)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16);
}

export function countLightMemoryHealthIssues(health: LightMemoryHealthReport | null): number {
  if (!health) return 0;
  return [
    health.indexTooLong,
    !health.indexExists && health.totalFiles > 0,
    ...health.missingInIndex,
    ...health.orphanInIndex,
    ...health.invalidFrontmatter,
    ...health.unreadableFiles,
    ...health.duplicateNames,
    ...health.duplicateDescriptions,
  ].filter(Boolean).length;
}

export function buildLightMemoryIssuePreview(health: LightMemoryHealthReport, t: Translations = zh): string[] {
  const issues: string[] = [];
  if (!health.indexExists && health.totalFiles > 0) issues.push(t.knowledgeMemory.healthIssueIndexMissing);
  if (health.indexTooLong) issues.push(t.knowledgeMemory.healthIssueIndexTooLong.replace('{count}', String(health.indexLineCount)));
  for (const filename of health.missingInIndex.slice(0, 3)) issues.push(t.knowledgeMemory.healthIssueMissingInIndex.replace('{filename}', filename));
  for (const filename of health.orphanInIndex.slice(0, 3)) issues.push(t.knowledgeMemory.healthIssueOrphanInIndex.replace('{filename}', filename));
  for (const item of health.invalidFrontmatter.slice(0, 3)) issues.push(`${item.filename}: ${item.reason}`);
  for (const item of health.unreadableFiles.slice(0, 2)) issues.push(`${item.filename}: ${item.reason}`);
  for (const item of health.duplicateNames.slice(0, 2)) issues.push(t.knowledgeMemory.healthIssueDuplicateName.replace('{value}', item.value));
  for (const item of health.duplicateDescriptions.slice(0, 2)) issues.push(t.knowledgeMemory.healthIssueDuplicateDescription.replace('{value}', item.value));
  return issues.slice(0, 5);
}
