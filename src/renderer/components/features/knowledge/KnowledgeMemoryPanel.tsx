import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Ban,
  Brain,
  ChevronDown,
  ChevronUp,
  Check,
  Clock3,
  Database,
  FileText,
  Inbox,
  MessageSquareText,
  PencilLine,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { isWebMode } from '../../../utils/platform';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';

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

interface LightMemoryHealthReport {
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

interface LightMemoryRebuildResult {
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

interface MemoryInjectionTrace {
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

interface AuditItem {
  id: string;
  title: string;
  summary: string;
  body?: string;
  category: MemoryCategory;
  source: string;
  origin: string;
  purpose: string;
  scope: '项目知识' | '个人/操作偏好' | '运行证据' | '未分类';
  updatedAt: number | null;
  confidence?: number;
  injection: 'seed-candidate' | 'memory-index' | 'recent-conversations' | 'available' | 'stored';
}

interface InboxItem {
  id: string;
  contentHash: string;
  kind: '候选项目知识' | '会话结论' | '失败复盘' | '可沉淀经验';
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

type InboxStatus = 'approving' | 'rejecting' | 'approved' | 'rejected';

const CATEGORY_META: Record<MemoryCategory, CategoryMeta> = {
  user_preferences: { label: '用户偏好', tone: 'text-sky-300 border-sky-500/30 bg-sky-500/10', Icon: Brain },
  project_rules: { label: '项目规则', tone: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', Icon: FileText },
  recent_topics: { label: '近期主题', tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10', Icon: Clock3 },
  agent_behavior: { label: 'agent 行为指令', tone: 'text-violet-300 border-violet-500/30 bg-violet-500/10', Icon: ShieldCheck },
  uncategorized: { label: '未分类', tone: 'text-zinc-300 border-zinc-600 bg-zinc-800/70', Icon: Database },
};

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

function formatTime(value: number | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatConfidence(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
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

function lightFilePurpose(file: LightMemoryFile, category: MemoryCategory): string {
  if (category === 'user_preferences') return '影响默认沟通方式、工具选择或长期个人偏好。';
  if (category === 'project_rules') return '影响当前项目里的实现边界、命名和技术判断。';
  if (category === 'agent_behavior') return '约束 agent 的行为方式、回复风格或执行纪律。';
  if (category === 'recent_topics') return '帮助恢复最近反复出现的任务背景。';
  return '只有 agent 主动读取时才会影响当前会话。';
}

function storedMemoryPurpose(memory: StoredMemory, isSeedCandidate: boolean): string {
  if (isSeedCandidate) return '当前项目会话启动时，seed-memory 可能把它放进系统上下文。';
  if (memory.source === 'session_extracted') return '来自压缩前保留摘要，后续同项目任务可能参考。';
  if (memory.type === 'user_preference') return '作为跨项目偏好，可能影响默认做法和沟通方式。';
  if (memory.type === 'project_knowledge') return '作为项目知识，可能影响当前仓库里的实现判断。';
  return '已存储，但当前没有直接注入证据。';
}

function sourceLabelForStored(memory: StoredMemory): string {
  const sourceMap: Record<StoredMemory['source'], string> = {
    auto_learned: '自动学习',
    user_defined: '用户写入',
    session_extracted: '压缩前提取',
  };
  const project = memory.projectPath ? ` · ${memory.projectPath}` : '';
  const session = memory.sessionId ? ` · session ${memory.sessionId}` : '';
  return `${sourceMap[memory.source]}${project}${session}`;
}

function scopeForStored(memory: StoredMemory): AuditItem['scope'] {
  if (memory.projectPath || memory.type === 'project_knowledge' || memory.type === 'code_pattern') return '项目知识';
  if (memory.type === 'user_preference' || memory.type === 'tool_usage') return '个人/操作偏好';
  if (memory.source === 'session_extracted') return '运行证据';
  return '未分类';
}

export function buildAuditItems(data: MemoryAuditPayload): AuditItem[] {
  const seedCandidateIds = new Set(data.seedCandidates.map((memory) => memory.id));
  const lightItems = data.lightFiles.map((file): AuditItem => {
    const category = classifyLightFile(file);
    return {
      id: `light:${file.filename}`,
      title: file.name || file.filename,
      summary: file.description || compactText(file.content, 140) || '(空)',
      body: file.content,
      category,
      source: `~/.code-agent/memory/${file.filename}`,
      origin: 'Light Memory 文件',
      purpose: lightFilePurpose(file, category),
      scope: category === 'project_rules' ? '项目知识' : category === 'user_preferences' || category === 'agent_behavior' ? '个人/操作偏好' : '未分类',
      updatedAt: Date.parse(file.updatedAt) || null,
      injection: 'available',
    };
  });

  const recentItems = data.lightStats.recentConversations.map((line, index): AuditItem => ({
    id: `recent:${index}`,
    title: parseRecentTitle(line) || `最近会话 ${index + 1}`,
    summary: compactText(line.replace(/^- /, ''), 160) || '(空)',
    category: 'recent_topics',
    source: '~/.code-agent/memory/recent-conversations.md',
    origin: 'Recent Conversations',
    purpose: '当用户提到之前、上次、历史或 recall 类意图时，recent_conversations 可能注入。',
    scope: '运行证据',
    updatedAt: null,
    injection: 'recent-conversations',
  }));

  const indexItems: AuditItem[] = data.lightFiles.length > 0
    ? [{
        id: 'light:index',
        title: 'Light Memory Index',
        summary: `${data.lightFiles.length} 个 Light Memory 文件可被 INDEX.md 暴露给 agent。`,
        category: 'agent_behavior',
        source: '~/.code-agent/memory/INDEX.md',
        origin: 'Memory index',
        purpose: '当用户提到记忆、之前、历史等意图时，memory_index 可能注入；日常对话只注入 memory_hint。',
        scope: '运行证据',
        updatedAt: Math.max(...data.lightFiles.map((file) => Date.parse(file.updatedAt) || 0)) || null,
        injection: 'memory-index',
      }]
    : [];

  const storedItems = data.databaseMemories.map((memory): AuditItem => {
    const isSeedCandidate = seedCandidateIds.has(memory.id);
    return {
      id: `db:${memory.id}`,
      title: compactText(memory.summary || memory.content, 80) || memory.category || memory.type,
      summary: compactText(memory.content, 180) || '(空)',
      body: memory.content,
      category: classifyStoredMemory(memory),
      source: sourceLabelForStored(memory),
      origin: memory.type,
      purpose: storedMemoryPurpose(memory, isSeedCandidate),
      scope: scopeForStored(memory),
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

export function buildInboxItems(data: MemoryAuditPayload): InboxItem[] {
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
      kind: memory.category === 'flush_decision' ? '候选项目知识' : '会话结论',
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || '(空)',
      content: memory.content,
      source: sourceLabelForStored(memory),
      reason: memory.category === 'flush_decision'
        ? '压缩前识别为关键决策，需要用户后续确认是否沉淀成稳定项目知识。'
        : '压缩前识别为用户要求，可能值得沉淀成稳定规则。',
      updatedAt: memory.updatedAt || memory.createdAt || null,
    }));

  const fromRecentConversations = data.lightStats.recentConversations.slice(0, 6).map((line, index): InboxItem => ({
    id: `conversation:${index}`,
    contentHash: hashInboxContent(line.replace(/^- /, '').trim()),
    kind: '会话结论',
    title: parseRecentTitle(line) || `最近会话 ${index + 1}`,
    summary: compactText(line.replace(/^- /, ''), 180) || '(空)',
    content: line.replace(/^- /, '').trim(),
    source: '~/.code-agent/memory/recent-conversations.md',
    reason: '已有最近会话摘要，但当前没有自动确认/写入项目知识的闭环。',
    updatedAt: null,
  }));

  const fromFailurePatterns = data.databaseMemories
    .filter((memory) => !isResolvedInboxMemory(memory))
    .filter((memory) => /error|failure|solution|pattern|复盘|失败/i.test(`${memory.category} ${memory.content}`))
    .slice(0, 6)
    .map((memory): InboxItem => ({
      id: `pattern:${memory.id}`,
      contentHash: hashInboxContent(memory.content),
      kind: memory.category.includes('error') ? '失败复盘' : '可沉淀经验',
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || '(空)',
      content: memory.content,
      source: sourceLabelForStored(memory),
      reason: '识别到经验或失败信号，第一版只展示，不自动写入新的知识库条目。',
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
      setError(`Knowledge Inbox 处理失败：${message}`);
    }
  }, [currentSessionId, loadAudit, workingDirectory]);

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
      setError(`Light Memory 重建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRebuildingIndex(false);
    }
  }, [loadAudit]);

  const auditItems = useMemo(() => data ? buildAuditItems(data) : [], [data]);
  const inboxItems = useMemo(() => data ? buildInboxItems(data) : [], [data]);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100" data-testid="knowledge-memory-panel">
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
            <Brain className="h-5 w-5 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-zinc-100">Knowledge / Memory</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{data?.projectPath || workingDirectory || '全局上下文'}</span>
              {data?.sessionId || currentSessionId ? <span>session {data?.sessionId || currentSessionId}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadAudit()}
            disabled={isLoading}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            type="button"
            onClick={() => setShowKnowledgeMemoryPanel(false)}
            aria-label="关闭 Knowledge / Memory"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

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
              <span className="text-xs text-zinc-500">{inboxItems.length} 条</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {isLoading ? (
                <LoadingRows />
              ) : inboxItems.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="暂无待确认知识"
                  text="没有发现可直接复用的候选链路；刷新会重新读取 Light Memory 和最近会话。"
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
                  placeholder="搜索记忆"
                  className="h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 pl-8 pr-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-5 gap-2">
              {CATEGORY_ORDER.map((category) => {
                const meta = CATEGORY_META[category];
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
                icon={Database}
                title={query.trim() ? '没有匹配的记忆' : '暂无可审计记忆'}
                text={query.trim() ? '换个关键词再查。' : '当前没有 Light Memory 文件、DB 记忆或最近会话摘要。'}
              />
            ) : (
              <div className="space-y-4">
                {CATEGORY_ORDER.map((category) => {
                  const items = groupedAudit[category];
                  if (items.length === 0) return null;
                  const meta = CATEGORY_META[category];
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
    </div>
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

function buildLightMemoryIssuePreview(health: LightMemoryHealthReport): string[] {
  const issues: string[] = [];
  if (!health.indexExists && health.totalFiles > 0) issues.push('INDEX.md 缺失');
  if (health.indexTooLong) issues.push(`INDEX.md ${health.indexLineCount} 行`);
  for (const filename of health.missingInIndex.slice(0, 3)) issues.push(`未进索引: ${filename}`);
  for (const filename of health.orphanInIndex.slice(0, 3)) issues.push(`孤儿索引: ${filename}`);
  for (const item of health.invalidFrontmatter.slice(0, 3)) issues.push(`${item.filename}: ${item.reason}`);
  for (const item of health.unreadableFiles.slice(0, 2)) issues.push(`${item.filename}: ${item.reason}`);
  for (const item of health.duplicateNames.slice(0, 2)) issues.push(`重复名称: ${item.value}`);
  for (const item of health.duplicateDescriptions.slice(0, 2)) issues.push(`重复描述: ${item.value}`);
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
  const issueCount = countLightMemoryHealthIssues(health);
  const issuePreview = health ? buildLightMemoryIssuePreview(health) : [];
  const statusLabel = !health || isLoading
    ? '检查中'
    : issueCount === 0
      ? '健康'
      : `${issueCount} 项`;
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
          重建索引
        </button>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          <HealthMetric label="文件" value={health?.totalFiles ?? '-'} />
          <HealthMetric label="索引行" value={health?.indexLineCount ?? '-'} />
          <HealthMetric label="缺口" value={issueCount} />
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
            INDEX.md 与 Light Memory 文件一致。
          </div>
        )}
        {rebuildResult ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] leading-4 text-zinc-400">
            已索引 {rebuildResult.indexedFiles}/{rebuildResult.totalFiles}
            {rebuildResult.skippedFiles.length > 0 ? `，跳过 ${rebuildResult.skippedFiles.length}` : ''}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function HealthMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold leading-none text-zinc-100">{value}</div>
    </div>
  );
}

export function MemoryInjectionTraceList({ traces }: { traces: MemoryInjectionTrace[] }) {
  const recentTraces = traces.slice(0, 5);
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5" data-testid="memory-injection-traces">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-emerald-300" />
          <span className="text-[11px] font-medium text-zinc-300">Injection Trace</span>
        </div>
        <span className="text-[11px] text-zinc-600">{traces.length} 条</span>
      </div>
      {recentTraces.length === 0 ? (
        <div className="text-[11px] text-zinc-500">暂无本进程注入记录。</div>
      ) : (
        <div className="grid gap-1.5">
          {recentTraces.map((trace) => (
            <div key={trace.id} className="flex min-w-0 items-center gap-2 text-[11px] leading-4">
              <span className={`shrink-0 rounded border px-1.5 py-0.5 ${trace.injected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>
                {trace.injected ? '已注入' : '未注入'}
              </span>
              <span className="shrink-0 font-medium text-zinc-300">{trace.blockType}</span>
              <span className="min-w-0 truncate text-zinc-500">{trace.trigger} · {trace.count} 项 · {trace.chars} chars</span>
              <span className="ml-auto shrink-0 text-zinc-600">{formatTraceTime(trace.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTraceTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function KnowledgeInboxList({
  items,
  editingId,
  draftById,
  statusById,
  errorById,
  onApprove,
  onReject,
  onEdit,
  onDraftChange,
  onCancelEdit,
  onApproveEdit,
}: {
  items: InboxItem[];
  editingId: string | null;
  draftById: Record<string, string>;
  statusById: Record<string, InboxStatus>;
  errorById: Record<string, string>;
  onApprove: (item: InboxItem) => void;
  onReject: (item: InboxItem) => void;
  onEdit: (item: InboxItem) => void;
  onDraftChange: (id: string, value: string) => void;
  onCancelEdit: () => void;
  onApproveEdit: (item: InboxItem, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const status = statusById[item.id];
        const isBusy = status === 'approving' || status === 'rejecting';
        const isEditing = editingId === item.id;
        const draft = draftById[item.id] ?? item.content;
        return (
          <article key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium text-amber-300">{item.kind}</span>
                  {status ? <InboxStatusBadge status={status} /> : null}
                </div>
                <h4 className="mt-1 line-clamp-2 text-sm font-medium text-zinc-100">{item.title}</h4>
              </div>
              <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(item.updatedAt)}</span>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">{item.summary}</p>
            <dl className="mt-3 space-y-1 text-[11px] leading-4 text-zinc-500">
              <div>
                <dt className="inline text-zinc-400">来源: </dt>
                <dd className="inline">{item.source}</dd>
              </div>
              <div>
                <dt className="inline text-zinc-400">用途: </dt>
                <dd className="inline">{item.reason}</dd>
              </div>
            </dl>

            {isEditing ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={draft}
                  onChange={(event) => onDraftChange(item.id, event.target.value)}
                  className="min-h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-200 outline-none focus:border-emerald-500/70"
                  aria-label={`编辑 ${item.title}`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onApproveEdit(item, draft)}
                    disabled={isBusy || !draft.trim()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    保存采纳
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    disabled={isBusy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onApprove(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  采纳
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 text-[11px] font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
                >
                  <PencilLine className="h-3.5 w-3.5" />
                  编辑采纳
                </button>
                <button
                  type="button"
                  onClick={() => onReject(item)}
                  disabled={isBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" />
                  忽略
                </button>
              </div>
            )}

            {errorById[item.id] ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] leading-4 text-red-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{errorById[item.id]}</span>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function InboxStatusBadge({ status }: { status: InboxStatus }) {
  const label: Record<InboxStatus, string> = {
    approving: '采纳中',
    rejecting: '忽略中',
    approved: '已采纳',
    rejected: '已忽略',
  };
  const tone = status === 'approved'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
    : status === 'rejected'
      ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>
      {label[status]}
    </span>
  );
}

function AuditRow({ item }: { item: AuditItem }) {
  const confidence = formatConfidence(item.confidence);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasBody = Boolean(item.body?.trim());
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <InjectionBadge value={item.injection} />
            <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">{item.scope}</span>
            {confidence ? <span className="text-[11px] text-zinc-600">confidence {confidence}</span> : null}
          </div>
          <h4 className="mt-2 line-clamp-2 text-sm font-medium text-zinc-100">{item.title}</h4>
        </div>
        <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(item.updatedAt)}</span>
      </div>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">{item.summary}</p>
      <dl className="mt-3 grid grid-cols-1 gap-1 text-[11px] leading-4 text-zinc-500 lg:grid-cols-2">
        <div>
          <dt className="inline text-zinc-400">来源: </dt>
          <dd className="inline break-all">{item.source}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">用途: </dt>
          <dd className="inline">{item.purpose}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-400">类型: </dt>
          <dd className="inline">{item.origin}</dd>
        </div>
      </dl>
      {hasBody ? (
        <div className="mt-3 border-t border-zinc-800 pt-2">
          <button
            type="button"
            onClick={() => setIsExpanded((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {isExpanded ? '收起原文证据' : '查看原文证据'}
          </button>
          {isExpanded ? (
            <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-5 text-zinc-300">
              {item.body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function InjectionBadge({ value }: { value: AuditItem['injection'] }) {
  const labels: Record<AuditItem['injection'], { text: string; className: string; Icon: LucideIcon }> = {
    'seed-candidate': { text: 'seed 候选', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', Icon: Zap },
    'memory-index': { text: 'index 候选', className: 'border-sky-500/30 bg-sky-500/10 text-sky-300', Icon: FileText },
    'recent-conversations': { text: 'recent 候选', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', Icon: MessageSquareText },
    available: { text: '按需读取', className: 'border-zinc-700 bg-zinc-800/70 text-zinc-300', Icon: FileText },
    stored: { text: '已存储', className: 'border-zinc-700 bg-zinc-800/70 text-zinc-400', Icon: Database },
  };
  const config = labels[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${config.className}`}>
      <config.Icon className="h-3 w-3" />
      {config.text}
    </span>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-950/60" />
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 px-6 text-center">
      <Icon className="h-8 w-8 text-zinc-600" />
      <h4 className="mt-3 text-sm font-medium text-zinc-300">{title}</h4>
      <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">{text}</p>
    </div>
  );
}
