import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { Loader2, Search, Sparkles } from 'lucide-react';
import type { NeoWorkCardDetail } from '@shared/contract/tag';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import {
  ensureNeoWorkCardLiveUpdates,
  isNeoWorkCardAwaitingRuntimeTerminal,
  NEO_WORK_CARD_LIVE_REFRESH_MS,
  selectNeoWorkCardDetailsForProject,
  useNeoWorkCardStore,
} from '../../../stores/neoWorkCardStore';
import {
  isInternalCompletedMarker,
  NEO_WORK_CARD_PHASE_CHIP_STYLE,
  NEO_WORK_CARD_PHASE_LABEL,
  statusPhase,
  type NeoWorkCardPhase,
} from '../chat/neoWorkCardPhase';
import { formatRequesterLabel } from './projectCollaborationData';
import { ProjectCollaborationDetailPane } from './ProjectCollaborationDetailPane';

// ============================================================================
// @neo topic 目录（Neo Tag 轻量化重设计）
// 左下 tag 菜单点开 = 所有 @neo topic 的列表（标题/相位/发起人/最近活动）+ 详情。
// 砍掉旧的 status 分组仪表盘 / 决策 / 上下文审计 / 审批动作。
// ============================================================================

export interface ProjectCollaborationPanelProps {
  projectId?: string | null;
  /** 注入的 topic 明细（测试/fixture 用）。传入时绕开 store 加载。 */
  details?: NeoWorkCardDetail[];
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
  const done = latest.completed.filter((item) => !isInternalCompletedMarker(item));
  if (done.length > 0) return done[done.length - 1];
  return latest.nextStep?.trim() || null;
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
  const { workCard } = detail;
  const phase = statusPhase(workCard.status);
  const snippet = topicActivitySnippet(detail);
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
        isSelected ? 'border-emerald-500/45 bg-emerald-500/[0.07]' : 'border-zinc-800 bg-zinc-950/45 hover:border-zinc-700'
      }`}
      data-testid={`neo-topic-row-${workCard.id}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[13px] font-medium text-zinc-100" title={workCard.title}>
          {workCard.title}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${NEO_WORK_CARD_PHASE_CHIP_STYLE[phase]}`}>
          {phase === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {NEO_WORK_CARD_PHASE_LABEL[phase]}
        </span>
      </div>
      {snippet && <div className="mt-1 line-clamp-1 text-[11px] leading-5 text-zinc-500">{snippet}</div>}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-600">
        <span className="truncate">{formatRequesterLabel(workCard.requesterUserId, currentUser)}</span>
        <span>{new Date(workCard.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}

export const ProjectCollaborationPanel: React.FC<ProjectCollaborationPanelProps> = ({
  projectId = null,
  details,
  onCancel,
  onArchive,
  onApproveMemory,
}) => {
  const currentUser = useAuthStore((state) => state.user ?? null);
  const actorUserId = currentUser?.id ?? 'local-user';
  const storeDetails = useNeoWorkCardStore(useShallow((state) => selectNeoWorkCardDetailsForProject(state, projectId)));
  const loading = useNeoWorkCardStore((state) => projectId ? Boolean(state.loadingProjectIds[projectId]) : false);
  const loadError = useNeoWorkCardStore((state) => projectId ? state.lastErrorByProjectId[projectId] ?? null : null);
  const loadForProject = useNeoWorkCardStore((state) => state.loadForProject);
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);

  const topics = useMemo(() => {
    const source = details ?? storeDetails;
    return [...source].sort((a, b) => b.workCard.updatedAt - a.workCard.updatedAt);
  }, [details, storeDetails]);

  const [selectedId, setSelectedId] = useState<string | null>(() => topics[0]?.workCard.id ?? null);
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

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
    if (details !== undefined || !projectId) return;
    void loadForProject(projectId, { includeArchived: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : '加载 Neo topic 失败');
    });
  }, [details, loadForProject, projectId]);
  const hasActiveTopic = storeDetails.some((detail) => isNeoWorkCardAwaitingRuntimeTerminal(detail.workCard.status));
  useEffect(() => {
    if (details !== undefined || !projectId || !hasActiveTopic) return;
    const interval = window.setInterval(() => {
      void loadForProject(projectId, { includeArchived: true }).catch((error) => {
        toast.error(error instanceof Error ? error.message : '刷新 Neo topic 失败');
      });
    }, NEO_WORK_CARD_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [details, hasActiveTopic, loadForProject, projectId]);
  useEffect(() => {
    if (filteredTopics.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !filteredTopics.some((detail) => detail.workCard.id === selectedId)) {
      setSelectedId(filteredTopics[0].workCard.id);
    }
  }, [filteredTopics, selectedId]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-900" data-testid="neo-topic-directory">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-emerald-500/20 bg-emerald-500/10">
            <Sparkles className="h-4 w-4 text-emerald-200" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-zinc-100">Neo 协同</h2>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {projectId ? `所有 @neo topic · ${projectId}` : '所有 @neo topic'}
            </div>
          </div>
          <span className="shrink-0 text-[11px] text-zinc-500" data-testid="neo-topic-count">
            {filteredTopics.length}/{topics.length}
          </span>
        </div>
        {loading && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载 topic
          </div>
        )}
        {loadError && (
          <div className="mt-3 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] leading-5 text-rose-100" data-testid="project-collab-load-error">
            {loadError}
          </div>
        )}
        {!projectId && details === undefined && (
          <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] leading-5 text-zinc-500">
            当前会话还没有绑定项目。先在已绑定项目的会话里 @neo，再回这里看它的 topic。
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <div className="mb-3 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索 topic / 步骤 / 文件"
                className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
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
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
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

        <ProjectCollaborationDetailPane
          detail={selectedDetail}
          currentUser={currentUser}
          onCancel={handleCancel}
          onArchive={handleArchive}
          onApproveMemory={handleApproveMemory}
        />
      </div>
    </div>
  );
};

export default ProjectCollaborationPanel;
