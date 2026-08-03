import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/shallow';
import { Loader2, Search, X } from 'lucide-react';
import type { NeoWorkCardDetail } from '@shared/contract/tag';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import {
  ensureNeoWorkCardLiveUpdates,
  isNeoWorkCardAwaitingRuntimeTerminal,
  NEO_WORK_CARD_ALL_SCOPE,
  NEO_WORK_CARD_LIVE_REFRESH_MS,
  selectAllNeoWorkCardDetails,
  selectNeoWorkCardDetailsForProject,
  useNeoWorkCardStore,
} from '../../../stores/neoWorkCardStore';
import {
  isInternalRuntimeText,
  NEO_WORK_CARD_PHASE_CHIP_STYLE,
  NEO_WORK_CARD_PHASE_LABEL,
  statusPhase,
  type NeoWorkCardPhase,
} from '../chat/neoWorkCardPhase';
import type { Message } from '@shared/contract/message';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import {
  formatNeoTopicDueDay,
  formatRequesterLabel,
  isNeoTopicDueOverdue,
  NEO_TOPIC_SORT_COMPARATORS,
  NEO_WORK_CARD_PRIORITY_CHIP_STYLE,
  type NeoTopicSortMode,
} from './projectCollaborationData';
import { ProjectCollaborationDetailPane } from './ProjectCollaborationDetailPane';

// ============================================================================
// @neo topic 目录（Neo Tag 轻量化重设计）
// 左下 tag 菜单点开 = 所有 @neo topic 的列表（标题/相位/发起人/最近活动）+ 详情。
// 砍掉旧的 status 分组仪表盘 / 决策 / 上下文审计 / 审批动作。
// ============================================================================

export interface ProjectCollaborationPanelProps {
  projectId?: string | null;
  /** 嵌入模式（项目空间任务 tab）：隐藏面板自带标题头（宿主页头已有项目名）。 */
  embedded?: boolean;
  /** 注入的 topic 明细（测试/fixture 用）。传入时绕开 store 加载。 */
  details?: NeoWorkCardDetail[];
  /** 注入的源会话消息（测试/fixture 用），key=sourceConversationId。传入时详情绕开 IPC 拉取。 */
  sourceMessagesByConversation?: Record<string, Message[]>;
  /** 跳回源会话；不传默认 switchSession（Page 入口会再叠加关闭全屏页）。 */
  onOpenConversation?: (sessionId: string) => void;
  onCancel?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
}

type PhaseFilter = 'all' | NeoWorkCardPhase;

const PHASE_FILTERS: Array<{ id: PhaseFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'needs_input', label: '待确认' },
  { id: 'done', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'closed', label: '已结束' },
];

function topicSearchText(detail: NeoWorkCardDetail): string {
  const revision = detail.currentRevision ?? detail.approvedRevision;
  return [
    detail.workCard.title,
    detail.workCard.requesterUserId,
    revision?.taskSummary,
    ...detail.deltas.flatMap((delta) => [...delta.completed, ...delta.changedFiles, delta.nextStep ?? '']),
  ].filter(Boolean).join('\n').toLowerCase();
}

function topicActivitySnippet(detail: NeoWorkCardDetail): string | null {
  const latest = detail.deltas.at(-1);
  if (!latest) return null;
  // 运行时记账文案（英文生命周期字符串）不是执行结果，不给用户看
  const done = latest.completed.filter((item) => !isInternalRuntimeText(item));
  if (done.length > 0) return done[done.length - 1];
  if (statusPhase(detail.workCard.status) === 'failed') {
    const lastRisk = latest.risks.at(-1)?.trim();
    if (lastRisk) return lastRisk;
  }
  const nextStep = latest.nextStep?.trim();
  return nextStep && !isInternalRuntimeText(nextStep) ? nextStep : null;
}

function TopicRow({
  detail,
  isSelected,
  currentUser,
  onSelect,
}: {
  detail: NeoWorkCardDetail;
  isSelected: boolean;
  currentUser?: { id?: string | null; name?: string | null; email?: string | null } | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const { workCard } = detail;
  const phase = statusPhase(workCard.status);
  const snippet = topicActivitySnippet(detail);
  const priority = workCard.priority ?? 'medium';
  const priorityLabel: Record<'urgent' | 'high' | 'low', string> = {
    urgent: t.neoTopics.priorityUrgent,
    high: t.neoTopics.priorityHigh,
    low: t.neoTopics.priorityLow,
  };
  const dueOverdue = isNeoTopicDueOverdue(workCard);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(workCard.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(workCard.id);
        }
      }}
      className={`rounded-md border px-3 py-2 text-left outline-none transition-colors ${
        isSelected ? 'border-badge-success/45 bg-emerald-500/[0.07]' : 'border-zinc-800 bg-zinc-950/45 hover:border-zinc-700'
      }`}
      data-testid={`neo-topic-row-${workCard.id}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[13px] font-medium text-zinc-100" title={workCard.title}>
          {workCard.title}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {priority !== 'medium' && (
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${NEO_WORK_CARD_PRIORITY_CHIP_STYLE[priority]}`}
              data-testid={`neo-topic-priority-${workCard.id}`}
            >
              {priorityLabel[priority]}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${NEO_WORK_CARD_PHASE_CHIP_STYLE[phase]}`}>
            {phase === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {NEO_WORK_CARD_PHASE_LABEL[phase]}
          </span>
        </span>
      </div>
      {snippet && <div className="mt-1 line-clamp-1 text-[11px] leading-5 text-zinc-500">{snippet}</div>}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-600">
        <span className="truncate">{formatRequesterLabel(workCard.requesterUserId, currentUser)}</span>
        <span>{new Date(workCard.updatedAt).toLocaleString()}</span>
        {workCard.dueAt != null && (
          <span
            className={dueOverdue ? 'font-medium text-rose-300' : undefined}
            data-testid={`neo-topic-due-${workCard.id}`}
          >
            {t.neoTopics.duePrefix} {formatNeoTopicDueDay(workCard.dueAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export const ProjectCollaborationPanel: React.FC<ProjectCollaborationPanelProps> = ({
  projectId = null,
  embedded = false,
  details,
  sourceMessagesByConversation,
  onOpenConversation,
  onCancel,
  onArchive,
  onApproveMemory,
}) => {
  const currentUser = useAuthStore((state) => state.user ?? null);
  const actorUserId = currentUser?.id ?? 'local-user';
  const { t } = useI18n();
  // 无绑定项目（projectId=null）= 全局目录：跨项目列全部 @neo topic（兜底建的卡挂在 proj_unsorted 等桶下）
  const scopeKey = projectId ?? NEO_WORK_CARD_ALL_SCOPE;
  const storeDetails = useNeoWorkCardStore(useShallow((state) => (
    projectId ? selectNeoWorkCardDetailsForProject(state, projectId) : selectAllNeoWorkCardDetails(state)
  )));
  const loading = useNeoWorkCardStore((state) => Boolean(state.loadingProjectIds[scopeKey]));
  const loadError = useNeoWorkCardStore((state) => state.lastErrorByProjectId[scopeKey] ?? null);
  const loadForProject = useNeoWorkCardStore((state) => state.loadForProject);
  const loadAll = useNeoWorkCardStore((state) => state.loadAll);
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);

  // 抽屉模型：默认不选中（列表先"扫"），点行才开详情抽屉
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<NeoTopicSortMode>('recent');

  const topics = useMemo(() => {
    const source = details ?? storeDetails;
    return [...source].sort(NEO_TOPIC_SORT_COMPARATORS[sortMode]);
  }, [details, storeDetails, sortMode]);

  const filteredTopics = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return topics.filter((detail) => {
      if (phaseFilter !== 'all' && statusPhase(detail.workCard.status) !== phaseFilter) return false;
      if (mineOnly && detail.workCard.requesterUserId !== actorUserId) return false;
      if (query && !topicSearchText(detail).includes(query)) return false;
      return true;
    });
  }, [actorUserId, mineOnly, phaseFilter, searchQuery, topics]);

  const selectedDetail = selectedId ? topics.find((detail) => detail.workCard.id === selectedId) ?? null : null;

  useEffect(() => {
    ensureNeoWorkCardLiveUpdates();
  }, []);
  useEffect(() => {
    if (details !== undefined) return;
    const load = projectId
      ? () => loadForProject(projectId, { includeArchived: true })
      : () => loadAll({ includeArchived: true });
    void load().catch((error) => {
      toast.error(error instanceof Error ? error.message : '加载 Neo topic 失败');
    });
  }, [details, loadAll, loadForProject, projectId]);
  const hasActiveTopic = storeDetails.some((detail) => isNeoWorkCardAwaitingRuntimeTerminal(detail.workCard.status));
  useEffect(() => {
    if (details !== undefined || !hasActiveTopic) return;
    const load = projectId
      ? () => loadForProject(projectId, { includeArchived: true })
      : () => loadAll({ includeArchived: true });
    const interval = window.setInterval(() => {
      void load().catch((error) => {
        toast.error(error instanceof Error ? error.message : '刷新 Neo topic 失败');
      });
    }, NEO_WORK_CARD_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [details, hasActiveTopic, loadAll, loadForProject, projectId]);
  // 选中的 topic 被过滤/删除后关抽屉；不自动替它选下一个（抽屉只因用户点击而开）
  useEffect(() => {
    if (selectedId && !filteredTopics.some((detail) => detail.workCard.id === selectedId)) {
      setSelectedId(null);
    }
  }, [filteredTopics, selectedId]);

  // Esc 关抽屉
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  // 外部点击收起：pointerdown 先关，落在别的 topic 行上时其 click 随后重开新详情（保持"点别的行直接切换"）
  const drawerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (drawerRef.current && event.target instanceof Node && !drawerRef.current.contains(event.target)) {
        setSelectedId(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [selectedId]);

  const handleCancel = useCallback(async (workCardId: string) => {
    try {
      if (onCancel) await onCancel(workCardId);
      else await cancel({ workCardId, actorUserId, feedback: '用户取消' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消 topic 失败');
    }
  }, [actorUserId, cancel, onCancel]);
  const handleArchive = useCallback(async (workCardId: string) => {
    try {
      if (onArchive) await onArchive(workCardId);
      else await archive({ workCardId, actorUserId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档 topic 失败');
    }
  }, [actorUserId, archive, onArchive]);
  const handleApproveMemory = useCallback(async (candidateId: string) => {
    try {
      if (onApproveMemory) await onApproveMemory(candidateId);
      else await approveMemoryCandidate({ candidateId, actorUserId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '写入记忆失败');
    }
  }, [actorUserId, approveMemoryCandidate, onApproveMemory]);
  const handleOpenConversation = useCallback((sessionId: string) => {
    if (onOpenConversation) {
      onOpenConversation(sessionId);
      return;
    }
    void useSessionStore.getState().switchSession(sessionId).catch((error) => {
      toast.error(error instanceof Error ? error.message : '打开会话失败');
    });
  }, [onOpenConversation]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900" data-testid="neo-topic-directory">
      {/* 标题由 Page 层 FullScreenPageHeader 统一承担（2026-07-29 去掉重复的「Neo 协同」旧 header），
          这里只剩加载/错误指示；嵌入模式的间距继续由宿主 tab 统一承担。 */}
      {(loading || loadError) && (
        <div className={embedded ? 'shrink-0 px-4' : 'shrink-0 border-b border-zinc-800 px-4 py-3'}>
          {loading && (
            <div className="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载 topic
            </div>
          )}
          {loadError && (
            <div className="rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] leading-5 text-rose-100" data-testid="project-collab-load-error">
              {loadError}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <div className={embedded ? 'h-full min-h-0 overflow-y-auto px-4 pb-3' : 'h-full min-h-0 overflow-y-auto px-4 py-3'}>
          <div className="mb-3 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索 topic / 步骤 / 文件"
                className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-success/60"
                data-testid="neo-topic-search"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PHASE_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setPhaseFilter(filter.id)}
                  className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                    phaseFilter === filter.id
                      ? 'border-badge-success/40 bg-emerald-500/10 text-badge-success'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                  data-testid={`neo-topic-filter-${filter.id}`}
                >
                  {filter.label}
                </button>
              ))}
              <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(event) => setMineOnly(event.target.checked)}
                  className="h-3.5 w-3.5 accent-emerald-500"
                  data-testid="neo-topic-mine-filter"
                />
                只看我的
              </label>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as NeoTopicSortMode)}
                className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 text-[11px] text-zinc-400 outline-none focus:border-badge-success/60"
                data-testid="neo-topic-sort"
              >
                <option value="recent">{t.neoTopics.sortRecent}</option>
                <option value="priority">{t.neoTopics.sortPriority}</option>
                <option value="dueAt">{t.neoTopics.sortDueAt}</option>
              </select>
            </div>
          </div>

          {filteredTopics.length > 0 ? (
            <div className="grid gap-1.5">
              {filteredTopics.map((detail) => (
                <TopicRow
                  key={detail.workCard.id}
                  detail={detail}
                  isSelected={selectedId === detail.workCard.id}
                  currentUser={currentUser}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-3 py-6 text-center text-xs text-zinc-600" data-testid="neo-topic-empty">
              还没有 @neo topic。在对话里 @neo 交代一件事，它就会出现在这里。
            </div>
          )}
        </div>

      </div>

      {/* 详情 = 非模态右侧抽屉：列表保持可点（点别的行直接切换内容），X/Esc/外部点击关闭。
          portal 到 body + fixed：占满 app 全高（挂载点在全屏页 banner 之下，absolute 只能盖住面板区）。 */}
      {selectedDetail && createPortal(
        <div
          ref={drawerRef}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-zinc-800 bg-zinc-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.8)]"
          data-testid="neo-topic-drawer"
          role="complementary"
          aria-label="topic 详情"
        >
          <div className="flex shrink-0 items-center justify-end border-b border-zinc-800/70 px-2 py-1.5">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="关闭详情"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
              data-testid="neo-topic-drawer-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProjectCollaborationDetailPane
              detail={selectedDetail}
              currentUser={currentUser}
              messagesByConversation={sourceMessagesByConversation}
              onOpenConversation={handleOpenConversation}
              onCancel={handleCancel}
              onArchive={handleArchive}
              onApproveMemory={handleApproveMemory}
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ProjectCollaborationPanel;
