/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Brain,
  Archive,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Edit3,
  Eye,
  GitPullRequestArrow,
  ListOrdered,
  Loader2,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '@shared/contract/tag';
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
  buildProjectCollaborationGroups,
  type ProjectCollaborationContextAudit,
  type ProjectCollaborationDecisionItem,
  type ProjectCollaborationMemoryCandidate,
  type ProjectCollaborationWorkCardRecord,
} from './projectCollaborationData';
import { ProjectCollaborationDetailPane } from './ProjectCollaborationDetailPane';
import {
  buildSearchText,
  ContextAuditRow,
  DecisionRow,
  detailFromRecord,
  EmptySection,
  getDefaultSelectedWorkCardId,
  matchesStatusFilter,
  MemoryCandidateRow,
  type ProjectCollaborationStatusFilter,
  recordFromDetail,
  STATUS_FILTERS,
  WorkCardSection,
} from './ProjectCollaborationRows';

export interface ProjectCollaborationPanelProps {
  projectId?: string | null;
  records?: ProjectCollaborationWorkCardRecord[];
  onUpdateDraft?: (workCardId: string, title: string, taskSummary: string) => void | Promise<void>;
  onApprove?: (workCardId: string) => void | Promise<void>;
  onReject?: (workCardId: string) => void | Promise<void>;
  onCancel?: (workCardId: string) => void | Promise<void>;
  onAcceptResult?: (workCardId: string) => void | Promise<void>;
  onRequestChanges?: (workCardId: string) => void | Promise<void>;
  onArchive?: (workCardId: string) => void | Promise<void>;
  onApproveMemory?: (candidateId: string) => void | Promise<void>;
  onRejectMemory?: (candidateId: string) => void | Promise<void>;
}

export const ProjectCollaborationPanel: React.FC<ProjectCollaborationPanelProps> = ({
  projectId = null,
  records,
  onUpdateDraft,
  onApprove,
  onReject,
  onCancel,
  onAcceptResult,
  onRequestChanges,
  onArchive,
  onApproveMemory,
  onRejectMemory,
}) => {
  const actorUserId = useAuthStore((state) => state.user?.id ?? 'local-user');
  const storeDetails = useNeoWorkCardStore(useShallow((state) => selectNeoWorkCardDetailsForProject(state, projectId)));
  const loading = useNeoWorkCardStore((state) => projectId ? Boolean(state.loadingProjectIds[projectId]) : false);
  const loadError = useNeoWorkCardStore((state) => projectId ? state.lastErrorByProjectId[projectId] ?? null : null);
  const loadForProject = useNeoWorkCardStore((state) => state.loadForProject);
  const updateDraftRevision = useNeoWorkCardStore((state) => state.updateDraftRevision);
  const approve = useNeoWorkCardStore((state) => state.approve);
  const reject = useNeoWorkCardStore((state) => state.reject);
  const cancel = useNeoWorkCardStore((state) => state.cancel);
  const acceptResult = useNeoWorkCardStore((state) => state.acceptResult);
  const requestChanges = useNeoWorkCardStore((state) => state.requestChanges);
  const archive = useNeoWorkCardStore((state) => state.archive);
  const approveMemoryCandidate = useNeoWorkCardStore((state) => state.approveMemoryCandidate);
  const rejectMemoryCandidate = useNeoWorkCardStore((state) => state.rejectMemoryCandidate);
  const derivedRecords = useMemo(
    () => storeDetails.map(recordFromDetail).filter((record): record is ProjectCollaborationWorkCardRecord => Boolean(record)),
    [storeDetails],
  );
  const panelRecords = records ?? derivedRecords;
  const [selectedWorkCardId, setSelectedWorkCardId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProjectCollaborationStatusFilter>('all');
  const [requesterFilter, setRequesterFilter] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const detailById = useMemo(() => {
    const map = new Map(storeDetails.map((detail) => [detail.workCard.id, detail]));
    for (const record of panelRecords) {
      if (!map.has(record.card.id)) map.set(record.card.id, detailFromRecord(record));
    }
    return map;
  }, [panelRecords, storeDetails]);
  const requesterOptions = useMemo(() => {
    return Array.from(new Set(panelRecords.map((record) => record.card.requesterUserId))).sort();
  }, [panelRecords]);
  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return panelRecords.filter((record) => {
      if (!matchesStatusFilter(record.card.status, statusFilter)) return false;
      if (requesterFilter !== 'all' && record.card.requesterUserId !== requesterFilter) return false;
      if (mineOnly && record.card.requesterUserId !== actorUserId) return false;
      if (query && !buildSearchText(record, detailById.get(record.card.id)).includes(query)) return false;
      return true;
    });
  }, [actorUserId, detailById, mineOnly, panelRecords, requesterFilter, searchQuery, statusFilter]);
  const groups = useMemo(() => buildProjectCollaborationGroups(filteredRecords), [filteredRecords]);
  const selectedDetail = selectedWorkCardId ? detailById.get(selectedWorkCardId) ?? null : null;
  useEffect(() => {
    ensureNeoWorkCardLiveUpdates();
  }, []);
  useEffect(() => {
    if (records !== undefined || !projectId) return;
    void loadForProject(projectId, { includeArchived: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : '加载 Neo work cards 失败');
    });
  }, [loadForProject, projectId, records]);
  const hasNeoWorkCardAwaitingRuntimeTerminal = storeDetails.some((detail) =>
    isNeoWorkCardAwaitingRuntimeTerminal(detail.workCard.status)
  );
  useEffect(() => {
    if (records !== undefined || !projectId || !hasNeoWorkCardAwaitingRuntimeTerminal) return;
    const interval = window.setInterval(() => {
      void loadForProject(projectId, { includeArchived: true }).catch((error) => {
        toast.error(error instanceof Error ? error.message : '刷新 Neo work cards 失败');
      });
    }, NEO_WORK_CARD_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [hasNeoWorkCardAwaitingRuntimeTerminal, loadForProject, projectId, records]);
  useEffect(() => {
    if (filteredRecords.length === 0) {
      if (selectedWorkCardId !== null) setSelectedWorkCardId(null);
      return;
    }
    if (!selectedWorkCardId || !filteredRecords.some((record) => record.card.id === selectedWorkCardId)) {
      setSelectedWorkCardId(getDefaultSelectedWorkCardId(filteredRecords));
    }
  }, [filteredRecords, selectedWorkCardId]);
  const handleUpdateDraft = useCallback(async (workCardId: string, title: string, taskSummary: string) => {
    try {
      if (onUpdateDraft) {
        await onUpdateDraft(workCardId, title, taskSummary);
        return;
      }
      const detail = detailById.get(workCardId);
      const revision = detail?.currentRevision ?? detail?.approvedRevision;
      if (!revision) throw new Error('Neo work card 缺少当前修订，无法保存草稿。');
      await updateDraftRevision({
        workCardId,
        updatedByUserId: actorUserId,
        title,
        revision: {
          intent: revision.intent,
          taskSummary,
          readScope: revision.readScope,
          writeScope: revision.writeScope,
          modelIntent: revision.modelIntent,
          memoryPlan: revision.memoryPlan,
          expectedOutputs: revision.expectedOutputs,
          risks: revision.risks,
          assumptions: revision.assumptions,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存 Neo work card 草稿失败');
      throw error;
    }
  }, [actorUserId, detailById, onUpdateDraft, updateDraftRevision]);
  const handleApprove = useCallback(async (workCardId: string) => {
    try {
      if (onApprove) {
        await onApprove(workCardId);
      } else {
        const detail = detailById.get(workCardId);
        await approve({ workCardId, actorUserId, revisionId: detail?.workCard.currentRevisionId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准 Neo work card 失败');
    }
  }, [actorUserId, approve, detailById, onApprove]);
  const handleReject = useCallback(async (workCardId: string) => {
    try {
      if (onReject) {
        await onReject(workCardId);
      } else {
        const detail = detailById.get(workCardId);
        await reject({ workCardId, actorUserId, revisionId: detail?.workCard.currentRevisionId, feedback: '退回修改' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '拒绝 Neo work card 失败');
    }
  }, [actorUserId, detailById, onReject, reject]);
  const handleCancel = useCallback(async (workCardId: string) => {
    try {
      if (onCancel) {
        await onCancel(workCardId);
      } else {
        await cancel({ workCardId, actorUserId, feedback: '用户取消' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消 Neo work card 失败');
    }
  }, [actorUserId, cancel, onCancel]);
  const handleAcceptResult = useCallback(async (workCardId: string) => {
    try {
      if (onAcceptResult) {
        await onAcceptResult(workCardId);
      } else {
        await acceptResult({ workCardId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接受 Neo work card 结果失败');
    }
  }, [acceptResult, actorUserId, onAcceptResult]);
  const handleRequestChanges = useCallback(async (workCardId: string) => {
    try {
      if (onRequestChanges) {
        await onRequestChanges(workCardId);
      } else {
        await requestChanges({ workCardId, actorUserId, feedback: '需要继续修改' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '退回 Neo work card 失败');
    }
  }, [actorUserId, onRequestChanges, requestChanges]);
  const handleArchive = useCallback(async (workCardId: string) => {
    try {
      if (onArchive) {
        await onArchive(workCardId);
      } else {
        await archive({ workCardId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档 Neo work card 失败');
    }
  }, [actorUserId, archive, onArchive]);
  const handleApproveMemory = useCallback(async (candidateId: string) => {
    try {
      if (onApproveMemory) {
        await onApproveMemory(candidateId);
      } else {
        await approveMemoryCandidate({ candidateId, actorUserId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批准 Neo 记忆候选失败');
    }
  }, [actorUserId, approveMemoryCandidate, onApproveMemory]);
  const handleRejectMemory = useCallback(async (candidateId: string) => {
    try {
      if (onRejectMemory) {
        await onRejectMemory(candidateId);
      } else {
        await rejectMemoryCandidate({ candidateId, actorUserId, reason: '用户忽略' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '忽略 Neo 记忆候选失败');
    }
  }, [actorUserId, onRejectMemory, rejectMemoryCandidate]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-900">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-violet-500/20 bg-violet-500/10">
            <Sparkles className="h-4 w-4 text-violet-200" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Neo 项目合作</h2>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {projectId ? `Project work cards · ${projectId}` : 'Project work cards'}
            </div>
          </div>
        </div>
        {loading && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载 Neo work cards
          </div>
        )}
        {loadError && (
          <div
            className="mt-3 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] leading-5 text-rose-100"
            data-testid="project-collab-load-error"
          >
            {loadError}
          </div>
        )}
        {!projectId && records === undefined && (
          <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-[11px] leading-5 text-zinc-500">
            当前 web/browser 会话还没有项目绑定。浏览器模式不能打开系统目录选择器时，先使用当前工作区发起 @neo，或切到已经绑定项目的会话再看这里。
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <section data-testid="project-collab-section-overview" className="mb-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <ClipboardCheck className="h-3.5 w-3.5 text-zinc-500" />
                Overview
              </div>
              <span className="text-[10px] text-zinc-600">{filteredRecords.length}/{panelRecords.length}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
              {[
                ['全部', groups.overview.total, 'text-zinc-200'],
                ['待审', groups.overview.review, 'text-amber-200'],
                ['运行中', groups.overview.running, 'text-emerald-200'],
                ['结果待看', groups.overview.resultReview, 'text-cyan-200'],
                ['需处理', groups.overview.attention, 'text-rose-200'],
                ['队列', groups.overview.queue, 'text-sky-200'],
                ['已完成', groups.overview.completed, 'text-zinc-300'],
                ['已关闭', groups.overview.closed, 'text-zinc-500'],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-md border border-zinc-800 bg-zinc-950/45 px-2 py-2">
                  <div className="text-zinc-600">{label}</div>
                  <div className={`mt-0.5 text-sm font-semibold ${tone}`}>{value}</div>
                </div>
              ))}
            </div>
          </section>

          <section data-testid="project-collab-filters" className="mb-4 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/45 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索 title / summary / changedFiles"
                className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500/60"
                data-testid="project-collab-search"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setStatusFilter(filter.id)}
                  className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                    statusFilter === filter.id
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-100'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                  data-testid={`project-collab-status-filter-${filter.id}`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-[160px] flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
                发起人
                <select
                  value={requesterFilter}
                  onChange={(event) => setRequesterFilter(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-300 outline-none focus:border-violet-500/60"
                  data-testid="project-collab-requester-filter"
                >
                  <option value="all">全部</option>
                  {requesterOptions.map((requester) => (
                    <option key={requester} value={requester}>{requester}</option>
                  ))}
                </select>
              </label>
              <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(event) => setMineOnly(event.target.checked)}
                  className="h-3.5 w-3.5 accent-violet-500"
                  data-testid="project-collab-mine-filter"
                />
                只看我的
              </label>
            </div>
          </section>

          <div className="grid gap-4">
            <WorkCardSection
              id="review"
              title="待审"
              icon={<Clock3 className="h-3.5 w-3.5 text-amber-300" />}
              records={groups.review}
              emptyLabel="暂无待审 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
              onUpdateDraft={handleUpdateDraft}
              onApprove={handleApprove}
              onReject={handleReject}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="running"
              title="运行中"
              icon={<Loader2 className="h-3.5 w-3.5 text-emerald-300" />}
              records={groups.running}
              emptyLabel="暂无运行中的 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="result-review"
              title="结果待看"
              icon={<Eye className="h-3.5 w-3.5 text-cyan-300" />}
              records={groups.resultReview}
              emptyLabel="暂无结果待看"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onAcceptResult={handleAcceptResult}
              onRequestChanges={handleRequestChanges}
              onArchive={handleArchive}
              onCancel={handleCancel}
            />
            <WorkCardSection
              id="attention"
              title="需要处理"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-300" />}
              records={groups.attention}
              emptyLabel="暂无失败或阻塞的 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />
            <WorkCardSection
              id="completed"
              title="已完成"
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-zinc-400" />}
              records={groups.completed}
              emptyLabel="暂无已完成 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />
            <WorkCardSection
              id="closed"
              title="已关闭"
              icon={<Archive className="h-3.5 w-3.5 text-zinc-500" />}
              records={groups.closed}
              emptyLabel="暂无已关闭 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onArchive={handleArchive}
            />

            <section data-testid="project-collab-section-decisions" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <GitPullRequestArrow className="h-3.5 w-3.5 text-violet-300" />
                  决策
                </div>
                <span className="text-[10px] text-zinc-600">{groups.decisions.length}</span>
              </div>
              {groups.decisions.length > 0
                ? <div className="grid gap-1.5">{groups.decisions.map((item) => <DecisionRow key={item.id} item={item} />)}</div>
                : <EmptySection label="暂无项目决策" />}
            </section>

            <section data-testid="project-collab-section-memory" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <Brain className="h-3.5 w-3.5 text-fuchsia-300" />
                  记忆候选
                </div>
                <span className="text-[10px] text-zinc-600">{groups.memoryCandidates.length}</span>
              </div>
              {groups.memoryCandidates.length > 0
                ? (
                  <div className="grid gap-1.5">
                    {groups.memoryCandidates.map((item) => (
                      <MemoryCandidateRow
                        key={item.id}
                        item={item}
                        onApproveMemory={handleApproveMemory}
                        onRejectMemory={handleRejectMemory}
                      />
                    ))}
                  </div>
                )
                : <EmptySection label="暂无记忆候选" />}
            </section>

            <section data-testid="project-collab-section-context-audit" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-300" />
                  上下文审计
                </div>
                <span className="text-[10px] text-zinc-600">{groups.contextAudits.length}</span>
              </div>
              {groups.contextAudits.length > 0
                ? <div className="grid gap-1.5">{groups.contextAudits.map((item) => <ContextAuditRow key={item.id} item={item} />)}</div>
                : <EmptySection label="暂无上下文审计" />}
            </section>

            <WorkCardSection
              id="queue"
              title="队列"
              icon={<ListOrdered className="h-3.5 w-3.5 text-sky-300" />}
              records={groups.queue}
              emptyLabel="暂无排队 work card"
              selectedWorkCardId={selectedWorkCardId}
              onSelectWorkCard={setSelectedWorkCardId}
              onCancel={handleCancel}
            />
          </div>
        </div>

        <ProjectCollaborationDetailPane
          detail={selectedDetail}
          onApprove={handleApprove}
          onReject={handleReject}
          onCancel={handleCancel}
          onAcceptResult={handleAcceptResult}
          onRequestChanges={handleRequestChanges}
          onArchive={handleArchive}
          onApproveMemory={handleApproveMemory}
          onRejectMemory={handleRejectMemory}
        />
      </div>
    </div>
  );
};

export default ProjectCollaborationPanel;
