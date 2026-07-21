import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Brain,
  Clock3,
  Database,
  FileText,
  Inbox,
  RefreshCw,
  Search,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { isWebMode } from '../../../utils/platform';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { zh, type Translations } from '../../../i18n';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import {
  AuditRow,
  KnowledgeInboxList,
  LoadingRows,
} from './KnowledgeMemoryPanel.parts';
import { EmptyState } from '../../primitives';

interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  updatedAt: string;
}

interface LightMemoryStats {
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

interface MemoryAuditPayload {
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

type MemoryCategory =
  | 'user_preferences'
  | 'project_rules'
  | 'recent_topics'
  | 'agent_behavior'
  | 'uncategorized';

interface CategoryMeta {
  label: string;
  tone: string;
  Icon: LucideIcon;
}

export interface AuditItem {
  id: string;
  title: string;
  summary: string;
  body?: string;
  category: MemoryCategory;
  source: string;
  origin: string;
  purpose: string;
  scope: string;
  updatedAt: number | null;
  confidence?: number;
  injection: 'seed-candidate' | 'memory-index' | 'recent-conversations' | 'available' | 'stored';
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

function getCategoryMeta(t: Translations): Record<MemoryCategory, CategoryMeta> {
  return {
    user_preferences: { label: t.knowledgeMemory.categoryUserPreferences, tone: 'text-sky-300 border-sky-500/30 bg-sky-500/10', Icon: Brain },
    project_rules: { label: t.knowledgeMemory.categoryProjectRules, tone: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', Icon: FileText },
    recent_topics: { label: t.knowledgeMemory.categoryRecentTopics, tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10', Icon: Clock3 },
    agent_behavior: { label: t.knowledgeMemory.categoryAgentBehavior, tone: 'text-violet-300 border-violet-500/30 bg-violet-500/10', Icon: ShieldCheck },
    uncategorized: { label: t.knowledgeMemory.categoryUncategorized, tone: 'text-zinc-300 border-zinc-600 bg-zinc-800/70', Icon: Database },
  };
}

const CATEGORY_ORDER: MemoryCategory[] = [
  'user_preferences',
  'project_rules',
  'recent_topics',
  'agent_behavior',
  'uncategorized',
];

function isMemoryResponse<T>(value: unknown): value is MemoryResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

async function invokeMemoryAudit(payload: {
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

async function invokeMemoryCommand<T>(
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

async function invokeMemoryInboxResolve(payload: MemoryInboxResolvePayload): Promise<void> {
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

function classifyLightFile(file: LightMemoryFile): MemoryCategory {
  const text = `${file.filename} ${file.name} ${file.description} ${file.type}`.toLowerCase();
  if (file.type === 'user' || text.includes('preference') || text.includes('偏好')) return 'user_preferences';
  if (file.type === 'project' || text.includes('rule') || text.includes('decision') || text.includes('项目')) return 'project_rules';
  if (file.type === 'feedback' || text.includes('feedback') || text.includes('agent') || text.includes('persona')) return 'agent_behavior';
  if (file.filename.includes('recent') || text.includes('conversation') || text.includes('主题')) return 'recent_topics';
  return 'uncategorized';
}

function classifyStoredMemory(memory: StoredMemory): MemoryCategory {
  const text = `${memory.type} ${memory.category} ${memory.summary || ''} ${memory.content}`.toLowerCase();
  if (memory.type === 'user_preference' || text.includes('preference') || text.includes('偏好')) return 'user_preferences';
  if (memory.type === 'project_knowledge' || text.includes('requirement') || text.includes('decision')) return 'project_rules';
  if (memory.type === 'conversation' || memory.source === 'session_extracted') return 'recent_topics';
  if (memory.type === 'tool_usage' || text.includes('instruction') || text.includes('agent')) return 'agent_behavior';
  if (memory.type === 'code_pattern' && (text.includes('error') || text.includes('pattern'))) return 'agent_behavior';
  return 'uncategorized';
}

function lightFilePurpose(file: LightMemoryFile, category: MemoryCategory, t: Translations = zh): string {
  if (category === 'user_preferences') return t.knowledgeMemory.purposeUserPreference;
  if (category === 'project_rules') return t.knowledgeMemory.purposeProjectRules;
  if (category === 'agent_behavior') return t.knowledgeMemory.purposeAgentBehavior;
  if (category === 'recent_topics') return t.knowledgeMemory.purposeRecentTopics;
  return t.knowledgeMemory.purposeDefault;
}

function storedMemoryPurpose(memory: StoredMemory, isSeedCandidate: boolean, t: Translations = zh): string {
  if (isSeedCandidate) return t.knowledgeMemory.purposeSeedCandidate;
  if (memory.source === 'session_extracted') return t.knowledgeMemory.purposeSessionExtracted;
  if (memory.type === 'user_preference') return t.knowledgeMemory.purposeUserPreferenceStored;
  if (memory.type === 'project_knowledge') return t.knowledgeMemory.purposeProjectKnowledgeStored;
  return t.knowledgeMemory.purposeStoredDefault;
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

function scopeForStored(memory: StoredMemory, t: Translations = zh): AuditItem['scope'] {
  if (memory.projectPath || memory.type === 'project_knowledge' || memory.type === 'code_pattern') return t.knowledgeMemory.scopeProjectKnowledge;
  if (memory.type === 'user_preference' || memory.type === 'tool_usage') return t.knowledgeMemory.scopePersonalPreference;
  if (memory.source === 'session_extracted') return t.knowledgeMemory.scopeRuntimeEvidence;
  return t.knowledgeMemory.scopeUncategorized;
}

export function buildAuditItems(data: MemoryAuditPayload, t: Translations = zh): AuditItem[] {
  const seedCandidateIds = new Set(data.seedCandidates.map((memory) => memory.id));
  const lightItems = data.lightFiles.map((file): AuditItem => {
    const category = classifyLightFile(file);
    return {
      id: `light:${file.filename}`,
      title: file.name || file.filename,
      summary: file.description || compactText(file.content, 140) || t.knowledgeMemory.emptyPlaceholder,
      body: file.content,
      category,
      source: `~/.code-agent/memory/${file.filename}`,
      origin: t.knowledgeMemory.originLightMemoryFile,
      purpose: lightFilePurpose(file, category, t),
      scope: category === 'project_rules' ? t.knowledgeMemory.scopeProjectKnowledge : category === 'user_preferences' || category === 'agent_behavior' ? t.knowledgeMemory.scopePersonalPreference : t.knowledgeMemory.scopeUncategorized,
      updatedAt: Date.parse(file.updatedAt) || null,
      injection: 'available',
    };
  });

  const recentItems = data.lightStats.recentConversations.map((line, index): AuditItem => ({
    id: `recent:${index}`,
    title: parseRecentTitle(line) || t.knowledgeMemory.recentSessionTitle.replace('{index}', String(index + 1)),
    summary: compactText(line.replace(/^- /, ''), 160) || t.knowledgeMemory.emptyPlaceholder,
    category: 'recent_topics',
    source: '~/.code-agent/memory/recent-conversations.md',
    origin: 'Recent Conversations',
    purpose: t.knowledgeMemory.purposeRecentConversations,
    scope: t.knowledgeMemory.scopeRuntimeEvidence,
    updatedAt: null,
    injection: 'recent-conversations',
  }));

  const indexItems: AuditItem[] = data.lightFiles.length > 0
    ? [{
        id: 'light:index',
        title: 'Light Memory Index',
        summary: t.knowledgeMemory.lightMemoryIndexSummary.replace('{count}', String(data.lightFiles.length)),
        category: 'agent_behavior',
        source: '~/.code-agent/memory/INDEX.md',
        origin: 'Memory index',
        purpose: t.knowledgeMemory.purposeMemoryIndex,
        scope: t.knowledgeMemory.scopeRuntimeEvidence,
        updatedAt: Math.max(...data.lightFiles.map((file) => Date.parse(file.updatedAt) || 0)) || null,
        injection: 'memory-index',
      }]
    : [];

  const storedItems = data.databaseMemories.map((memory): AuditItem => {
    const isSeedCandidate = seedCandidateIds.has(memory.id);
    return {
      id: `db:${memory.id}`,
      title: compactText(memory.summary || memory.content, 80) || memory.category || memory.type,
      summary: compactText(memory.content, 180) || t.knowledgeMemory.emptyPlaceholder,
      body: memory.content,
      category: classifyStoredMemory(memory),
      source: sourceLabelForStored(memory, t),
      origin: memory.type,
      purpose: storedMemoryPurpose(memory, isSeedCandidate, t),
      scope: scopeForStored(memory, t),
      updatedAt: memory.updatedAt || memory.createdAt || null,
      confidence: memory.confidence,
      injection: isSeedCandidate ? 'seed-candidate' : 'stored',
    };
  });

  return [...storedItems, ...indexItems, ...lightItems, ...recentItems].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function parseRecentTitle(line: string): string | null {
  const match = line.match(/^- \*\*.+?\*\*: "(.+?)"/);
  return match?.[1] ?? null;
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

export const KnowledgeMemoryPanel: React.FC = () => {
  const { t } = useI18n();
  const setShowKnowledgeMemoryPanel = useAppStore((state) => state.setShowKnowledgeMemoryPanel);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [data, setData] = useState<MemoryAuditPayload | null>(null);
  const [lightHealth, setLightHealth] = useState<LightMemoryHealthReport | null>(null);
  const [rebuildResult, setRebuildResult] = useState<LightMemoryRebuildResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editingInboxId, setEditingInboxId] = useState<string | null>(null);
  const [draftByInboxId, setDraftByInboxId] = useState<Record<string, string>>({});
  const [inboxStatusById, setInboxStatusById] = useState<Record<string, InboxStatus>>({});
  const [inboxErrorById, setInboxErrorById] = useState<Record<string, string>>({});

  const loadAudit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [result, health] = await Promise.all([
        invokeMemoryAudit({
          projectPath: workingDirectory,
          sessionId: currentSessionId,
        }),
        invokeMemoryCommand<LightMemoryHealthReport>('lightHealth'),
      ]);
      setData(result);
      setLightHealth(health);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
      setLightHealth(null);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId, workingDirectory]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const handleResolveInboxItem = useCallback(async (
    item: InboxItem,
    decision: InboxDecision,
    content?: string,
  ) => {
    const runningStatus: InboxStatus = decision === 'approve' ? 'approving' : 'rejecting';
    const doneStatus: InboxStatus = decision === 'approve' ? 'approved' : 'rejected';
    setInboxStatusById((prev) => ({ ...prev, [item.id]: runningStatus }));
    setInboxErrorById((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setError(null);

    try {
      await invokeMemoryInboxResolve(buildMemoryInboxResolvePayload(item, decision, {
        content,
        projectPath: workingDirectory,
        sessionId: currentSessionId,
      }));
      setInboxStatusById((prev) => ({ ...prev, [item.id]: doneStatus }));
      setEditingInboxId((current) => current === item.id ? null : current);
      await loadAudit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setInboxStatusById((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setInboxErrorById((prev) => ({ ...prev, [item.id]: message }));
      setError(t.knowledgeMemory.inboxProcessFailed.replace('{message}', message));
    }
  }, [currentSessionId, loadAudit, t, workingDirectory]);

  const handleStartEditInboxItem = useCallback((item: InboxItem) => {
    setEditingInboxId(item.id);
    setDraftByInboxId((prev) => ({
      ...prev,
      [item.id]: prev[item.id] ?? item.content,
    }));
  }, []);

  const handleRebuildLightIndex = useCallback(async () => {
    setIsRebuildingIndex(true);
    setError(null);
    try {
      const result = await invokeMemoryCommand<LightMemoryRebuildResult>('lightRebuildIndex');
      setRebuildResult(result);
      await loadAudit();
    } catch (err) {
      setError(t.knowledgeMemory.lightRebuildFailed.replace('{message}', err instanceof Error ? err.message : String(err)));
    } finally {
      setIsRebuildingIndex(false);
    }
  }, [loadAudit, t]);

  const categoryMeta = useMemo(() => getCategoryMeta(t), [t]);
  const auditItems = useMemo(() => data ? buildAuditItems(data, t) : [], [data, t]);
  const inboxItems = useMemo(() => data ? buildInboxItems(data, t) : [], [data, t]);
  const filteredAuditItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return auditItems;
    return auditItems.filter((item) =>
      `${item.title} ${item.summary} ${item.source} ${item.origin} ${item.purpose}`
        .toLowerCase()
        .includes(needle),
    );
  }, [auditItems, query]);

  const counts = useMemo(() => {
    const next: Record<MemoryCategory, number> = {
      user_preferences: 0,
      project_rules: 0,
      recent_topics: 0,
      agent_behavior: 0,
      uncategorized: 0,
    };
    for (const item of filteredAuditItems) {
      next[item.category] += 1;
    }
    return next;
  }, [filteredAuditItems]);

  const groupedAudit = useMemo(() => {
    const groups: Record<MemoryCategory, AuditItem[]> = {
      user_preferences: [],
      project_rules: [],
      recent_topics: [],
      agent_behavior: [],
      uncategorized: [],
    };
    for (const item of filteredAuditItems) {
      groups[item.category].push(item);
    }
    return groups;
  }, [filteredAuditItems]);
  const contextLabel = data?.projectPath || workingDirectory || t.knowledgeMemory.contextGlobal;
  const sessionLabel = data?.sessionId || currentSessionId;

  return (
    <FullScreenPage testId="knowledge-memory-panel">
      <FullScreenPageHeader
        icon={<Brain className="h-4 w-4 text-emerald-300" />}
        title="Knowledge / Memory"
        description={`${contextLabel}${sessionLabel ? ` · session ${sessionLabel}` : ''}`}
        onClose={() => setShowKnowledgeMemoryPanel(false)}
        closeLabel={t.knowledgeMemory.closeLabel}
        actions={(
          <button
            type="button"
            onClick={() => void loadAudit()}
            disabled={isLoading}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            {t.knowledgeMemory.refresh}
          </button>
        )}
      />

      {error && (
        <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="grid flex-1 min-h-0 grid-cols-[minmax(280px,0.85fr)_minmax(420px,1.35fr)] gap-4 overflow-hidden p-5">
        <div className="flex min-h-0 flex-col gap-4">
          <LightMemoryHealthPanel
            health={lightHealth}
            rebuildResult={rebuildResult}
            isLoading={isLoading}
            isRebuilding={isRebuildingIndex}
            onRebuild={() => void handleRebuildLightIndex()}
          />

          <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-amber-300" />
                <h3 className="text-sm font-semibold text-zinc-100">Knowledge Inbox</h3>
              </div>
              <span className="text-xs text-zinc-500">{t.knowledgeMemory.countSuffix.replace('{count}', String(inboxItems.length))}</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {isLoading ? (
                <LoadingRows />
              ) : inboxItems.length === 0 ? (
                <EmptyState
                  variant="panel"
                  icon={Inbox}
                  title={t.knowledgeMemory.inboxEmptyTitle}
                  text={t.knowledgeMemory.inboxEmptyText}
                />
              ) : (
                <KnowledgeInboxList
                  items={inboxItems}
                  editingId={editingInboxId}
                  draftById={draftByInboxId}
                  statusById={inboxStatusById}
                  errorById={inboxErrorById}
                  onApprove={(item) => void handleResolveInboxItem(item, 'approve')}
                  onReject={(item) => void handleResolveInboxItem(item, 'reject')}
                  onEdit={handleStartEditInboxItem}
                  onDraftChange={(id, value) => setDraftByInboxId((prev) => ({ ...prev, [id]: value }))}
                  onCancelEdit={() => setEditingInboxId(null)}
                  onApproveEdit={(item, value) => void handleResolveInboxItem(item, 'approve', value)}
                />
              )}
            </div>
          </section>
        </div>

        <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-sky-300" />
                <h3 className="text-sm font-semibold text-zinc-100">Memory Audit</h3>
              </div>
              <div className="relative w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t.knowledgeMemory.searchPlaceholder}
                  className="h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 pl-8 pr-3 text-xs text-zinc-200 outline-hidden placeholder:text-zinc-600 focus:border-zinc-500"
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-5 gap-2">
              {CATEGORY_ORDER.map((category) => {
                const meta = categoryMeta[category];
                return (
                  <div key={category} className={`rounded-md border px-2 py-2 ${meta.tone}`}>
                    <div className="flex items-center gap-1.5">
                      <meta.Icon className="h-3.5 w-3.5" />
                      <span className="truncate text-[11px] font-medium">{meta.label}</span>
                    </div>
                    <div className="mt-1 text-lg font-semibold leading-none">{counts[category]}</div>
                  </div>
                );
              })}
            </div>
            <MemoryInjectionTraceList traces={data?.injectionTraces ?? []} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {isLoading ? (
              <LoadingRows />
            ) : filteredAuditItems.length === 0 ? (
              <EmptyState
                variant="panel"
                icon={Database}
                title={query.trim() ? t.knowledgeMemory.auditEmptyTitleFiltered : t.knowledgeMemory.auditEmptyTitleDefault}
                text={query.trim() ? t.knowledgeMemory.auditEmptyTextFiltered : t.knowledgeMemory.auditEmptyTextDefault}
              />
            ) : (
              <div className="space-y-4">
                {CATEGORY_ORDER.map((category) => {
                  const items = groupedAudit[category];
                  if (items.length === 0) return null;
                  const meta = categoryMeta[category];
                  return (
                    <div key={category}>
                      <div className="mb-2 flex items-center gap-2 px-1">
                        <meta.Icon className="h-4 w-4 text-zinc-500" />
                        <h4 className="text-xs font-semibold text-zinc-300">{meta.label}</h4>
                        <span className="text-[11px] text-zinc-600">{items.length}</span>
                      </div>
                      <div className="space-y-2">
                        {items.map((item) => (
                          <AuditRow key={item.id} item={item} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </FullScreenPage>
  );
};

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

function buildLightMemoryIssuePreview(health: LightMemoryHealthReport, t: Translations = zh): string[] {
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

export function LightMemoryHealthPanel({
  health,
  rebuildResult,
  isLoading,
  isRebuilding,
  onRebuild,
}: {
  health: LightMemoryHealthReport | null;
  rebuildResult: LightMemoryRebuildResult | null;
  isLoading: boolean;
  isRebuilding: boolean;
  onRebuild: () => void;
}) {
  const { t } = useI18n();
  const issueCount = countLightMemoryHealthIssues(health);
  const issuePreview = health ? buildLightMemoryIssuePreview(health, t) : [];
  const statusLabel = !health || isLoading
    ? t.knowledgeMemory.healthCheckingStatus
    : issueCount === 0
      ? t.knowledgeMemory.healthHealthyStatus
      : t.knowledgeMemory.healthIssueCountStatus.replace('{count}', String(issueCount));
  const statusTone = !health || isLoading
    ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
    : issueCount === 0
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60" data-testid="light-memory-health-panel">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-300" />
          <h3 className="text-sm font-semibold text-zinc-100">Light Memory</h3>
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${statusTone}`}>{statusLabel}</span>
        </div>
        <button
          type="button"
          onClick={onRebuild}
          disabled={isLoading || isRebuilding}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRebuilding ? 'animate-spin' : ''}`} />
          {t.knowledgeMemory.healthRebuildIndex}
        </button>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          <HealthMetric label={t.knowledgeMemory.healthMetricFiles} value={health?.totalFiles ?? '-'} />
          <HealthMetric label={t.knowledgeMemory.healthMetricIndexLines} value={health?.indexLineCount ?? '-'} />
          <HealthMetric label={t.knowledgeMemory.healthMetricIssues} value={issueCount} />
        </div>
        {issuePreview.length > 0 ? (
          <div className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-4 text-amber-100">
            {issuePreview.map((item) => (
              <div key={item} className="flex gap-1.5">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all">{item}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] text-zinc-500">
            {t.knowledgeMemory.healthIndexConsistent}
          </div>
        )}
        {rebuildResult ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] leading-4 text-zinc-400">
            {t.knowledgeMemory.healthRebuildSummary.replace('{indexed}', String(rebuildResult.indexedFiles)).replace('{total}', String(rebuildResult.totalFiles))}
            {rebuildResult.skippedFiles.length > 0 ? t.knowledgeMemory.healthRebuildSkipped.replace('{count}', String(rebuildResult.skippedFiles.length)) : ''}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export {
  KnowledgeInboxList,
} from './KnowledgeMemoryPanel.parts';

function HealthMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold leading-none text-zinc-100">{value}</div>
    </div>
  );
}

export function MemoryInjectionTraceList({ traces }: { traces: MemoryInjectionTrace[] }) {
  const { t } = useI18n();
  const recentTraces = traces.slice(0, 5);
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5" data-testid="memory-injection-traces">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-emerald-300" />
          <span className="text-[11px] font-medium text-zinc-300">Injection Trace</span>
        </div>
        <span className="text-[11px] text-zinc-600">{t.knowledgeMemory.countSuffix.replace('{count}', String(traces.length))}</span>
      </div>
      {recentTraces.length === 0 ? (
        <div className="text-[11px] text-zinc-500">{t.knowledgeMemory.injectionTraceEmpty}</div>
      ) : (
        <div className="grid gap-1.5">
          {recentTraces.map((trace) => (
            <div key={trace.id} className="flex min-w-0 items-center gap-2 text-[11px] leading-4">
              <span className={`shrink-0 rounded border px-1.5 py-0.5 ${trace.injected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>
                {trace.injected ? t.knowledgeMemory.injectionTraceInjected : t.knowledgeMemory.injectionTraceNotInjected}
              </span>
              <span className="shrink-0 font-medium text-zinc-300">{trace.blockType}</span>
              <span className="min-w-0 truncate text-zinc-500">{trace.trigger} · {t.knowledgeMemory.injectionTraceUnitCount.replace('{count}', String(trace.count))} · {trace.chars} chars</span>
              <span className="ml-auto shrink-0 text-zinc-600">{formatTraceTime(trace.timestamp, t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTraceTime(timestamp: number, t: Translations = zh): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return t.knowledgeMemory.traceTimeUnknown;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
