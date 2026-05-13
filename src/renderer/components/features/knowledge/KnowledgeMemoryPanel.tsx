import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  FileText,
  Inbox,
  MessageSquareText,
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
  kind: '候选项目知识' | '会话结论' | '失败复盘' | '可沉淀经验';
  title: string;
  summary: string;
  source: string;
  reason: string;
  updatedAt: number | null;
}

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

function compactText(value: string | undefined, limit = 180): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
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
  const fromSessionExtracted = data.databaseMemories
    .filter((memory) => memory.source === 'session_extracted')
    .slice(0, 8)
    .map((memory): InboxItem => ({
      id: `flush:${memory.id}`,
      kind: memory.category === 'flush_decision' ? '候选项目知识' : '会话结论',
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || '(空)',
      source: sourceLabelForStored(memory),
      reason: memory.category === 'flush_decision'
        ? '压缩前识别为关键决策，需要用户后续确认是否沉淀成稳定项目知识。'
        : '压缩前识别为用户要求，可能值得沉淀成稳定规则。',
      updatedAt: memory.updatedAt || memory.createdAt || null,
    }));

  const fromRecentConversations = data.lightStats.recentConversations.slice(0, 6).map((line, index): InboxItem => ({
    id: `conversation:${index}`,
    kind: '会话结论',
    title: parseRecentTitle(line) || `最近会话 ${index + 1}`,
    summary: compactText(line.replace(/^- /, ''), 180) || '(空)',
    source: '~/.code-agent/memory/recent-conversations.md',
    reason: '已有最近会话摘要，但当前没有自动确认/写入项目知识的闭环。',
    updatedAt: null,
  }));

  const fromFailurePatterns = data.databaseMemories
    .filter((memory) => /error|failure|solution|pattern|复盘|失败/i.test(`${memory.category} ${memory.content}`))
    .slice(0, 6)
    .map((memory): InboxItem => ({
      id: `pattern:${memory.id}`,
      kind: memory.category.includes('error') ? '失败复盘' : '可沉淀经验',
      title: compactText(memory.summary || memory.content, 80) || memory.category,
      summary: compactText(memory.content, 180) || '(空)',
      source: sourceLabelForStored(memory),
      reason: '识别到经验或失败信号，第一版只展示，不自动写入新的知识库条目。',
      updatedAt: memory.updatedAt || memory.createdAt || null,
    }));

  const seen = new Set<string>();
  return [...fromSessionExtracted, ...fromRecentConversations, ...fromFailurePatterns]
    .filter((item) => {
      const key = `${item.kind}:${item.title}:${item.summary}`;
      if (seen.has(key)) return false;
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadAudit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invokeMemoryAudit({
        projectPath: workingDirectory,
        sessionId: currentSessionId,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId, workingDirectory]);

  useEffect(() => {
    void loadAudit();
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
        <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
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
              <div className="space-y-2">
                {inboxItems.map((item) => (
                  <article key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-amber-300">{item.kind}</div>
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
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

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
