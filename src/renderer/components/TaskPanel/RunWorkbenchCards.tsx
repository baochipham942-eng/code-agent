import type React from 'react';
import { useState } from 'react';
import { BackgroundTaskSchemas } from '@shared/ipc/schemas';
import { getLongTaskStatusLabel } from '@shared/contract/productClosure';
import {
  AlertTriangle,
  ArrowUpRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ListChecks,
  Loader2,
  Radio,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { EmptyState } from '../primitives';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';
import type {
  LoopDecisionView,
  MemoryActivityEvent,
  RunWorkbenchModel,
  RunUiState,
  RunUiStatus,
  SubagentRunView,
  TaskRecord,
  TaskRecordOutputRef,
  ToolCapabilityView,
} from '../../types/runWorkbench';
import { isLiveRunStatus } from '../../utils/overviewRunHeader';
import {
  deriveTaskRailView,
  type TaskRailDependencySummary,
  type TaskRailStepView,
} from '../../utils/taskRailPresentation';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';
import { typedInvokeDomain } from '../../services/typedInvoke';

export function runStatusClass(status: RunUiStatus): string {
  switch (status) {
    case 'completed':
      return 'border-badge-success/20 bg-emerald-500/10 text-badge-success';
    case 'waiting_approval':
    case 'using_tools':
    case 'verifying':
      return 'border-badge-warning/20 bg-amber-500/10 text-badge-warning';
    case 'blocked':
    case 'cancelled':
      return 'border-red-500/20 bg-red-500/10 text-badge-danger';
    case 'planning':
    case 'running':
    default:
      return 'border-badge-info/20 bg-sky-500/10 text-badge-info';
  }
}

/** run.status（RunUiStatus）不是 TaskRecord['status']，两套枚举不共用同一份
 * 翻译表——running/completed/blocked/cancelled 复用既有 rw.status* 键，
 * planning/waiting_approval/using_tools/verifying 是 RunUiStatus 独有值。 */
export function getRunUiStatusLabel(status: RunUiStatus, t: Translations): string {
  const rw = t.taskStatusPanels.runWorkbench;
  switch (status) {
    case 'completed':
      return rw.statusCompleted;
    case 'blocked':
      return rw.statusBlocked;
    case 'cancelled':
      return rw.statusCancelled;
    case 'waiting_approval':
      return rw.statusWaitingApproval;
    case 'using_tools':
      return rw.statusUsingTools;
    case 'verifying':
      return rw.statusVerifying;
    case 'planning':
    case 'running':
      return rw.statusRunning;
    default:
      // 未知状态兜底显示原值（同 A-7 run.status 映射模式），别静默吞成「运行中」。
      return status;
  }
}

function subagentStatusClass(status: SubagentRunView['status']): string {
  switch (status) {
    case 'completed':
      return 'text-badge-success';
    case 'failed':
    case 'blocked':
      return 'text-badge-danger';
    case 'cancelled':
      return 'text-zinc-600';
    case 'queued':
    case 'waiting_approval':
    case 'paused':
      return 'text-badge-warning';
    case 'running':
    default:
      return 'text-badge-info';
  }
}

interface RunOverviewProps {
  model: RunWorkbenchModel;
  onOpenMemory?: () => void;
}

export const RunOverview = ({ model, onOpenMemory }: RunOverviewProps) => {
  const { t } = useI18n();
  const { run, memoryActivities } = model;
  const isCompleted = run.status === 'completed';
  const runBlockedHint = run.blockedReason
    || (run.blockedReasonCategory ? t.taskPanel.taskBlockedReason[run.blockedReasonCategory] : null);

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2">
        {isCompleted ? (
          <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-mark-success/50" />
        ) : (
          <Radio className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-badge-info" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isCompleted ? (
              <span className="truncate text-xs text-zinc-300">{run.phase}</span>
            ) : (
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${runStatusClass(run.status)}`}>
                {getRunUiStatusLabel(run.status, t)}
              </span>
            )}
            {run.activeToolName && (
              <span className="truncate text-[11px] text-zinc-500">{run.activeToolName}</span>
            )}
          </div>
          {!isCompleted && (
            <div className="mt-1 truncate text-xs text-zinc-200">{run.phase}</div>
          )}
          {/* 与任务轨同口径（ADR-050）：agent 的人话优先，判成 raw 日志时退回类别文案 */}
          {runBlockedHint && (
            <div className="mt-1 text-[11px] text-badge-warning">{runBlockedHint}</div>
          )}
        </div>
      </div>

      {memoryActivities.length > 0 && onOpenMemory && (
        <button
          type="button"
          onClick={onOpenMemory}
          data-testid="run-overview-memory-link"
          className="text-[11px] text-zinc-500 underline-offset-2 hover:text-badge-accent hover:underline"
        >
          Memory activity {memoryActivities.length}
        </button>
      )}
    </div>
  );
};

function getTaskStatusClass(status: TaskRecord['status']): string {
  switch (status) {
    case 'in_progress':
      return 'text-badge-info';
    case 'completed':
      return 'text-badge-success';
    case 'blocked':
      return 'text-badge-danger';
    case 'cancelled':
      return 'text-zinc-600 line-through';
    default:
      return 'text-zinc-500';
  }
}

function getTaskStatusLabel(status: TaskRecord['status'], t: Translations): string {
  const rw = t.taskStatusPanels.runWorkbench;
  switch (status) {
    case 'in_progress':
      return rw.statusRunning;
    case 'completed':
      return rw.statusCompleted;
    case 'blocked':
      return rw.statusBlocked;
    case 'cancelled':
      return rw.statusCancelled;
    default:
      return rw.statusPending;
  }
}

function getTaskScopeLabel(scope: TaskRecord['scope'], t: Translations): string {
  const rw = t.taskStatusPanels.runWorkbench;
  if (scope === 'global') return rw.scopeBackground;
  if (scope === 'scheduled') return rw.scopeSchedule;
  return rw.scopeSession;
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function joinDependencyTitles(titles: string[], language: string): string {
  return titles.join(language === 'en' ? ', ' : '、');
}

function dependencySummaryLabel(
  summary: TaskRailDependencySummary | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  if (!summary) return null;

  const parts: string[] = [];
  if (summary.waitingCount > 0) {
    parts.push(formatTemplate(t.taskPanel.taskDependencySummaryWaiting, {
      count: summary.waitingCount,
    }));
  }
  if (summary.unlockingCount > 0) {
    parts.push(formatTemplate(t.taskPanel.taskDependencySummaryUnlocking, {
      count: summary.unlockingCount,
    }));
  }

  return parts.length > 0 ? parts.join(t.taskPanel.taskDependencySummarySeparator) : null;
}

export const TaskDashboardSummary = ({
  tasks,
  run,
  showOutputRefs = true,
}: {
  tasks: TaskRecord[];
  run?: RunUiState | null;
  showOutputRefs?: boolean;
}) => {
  const { t } = useI18n();
  const rw = t.taskStatusPanels.runWorkbench;
  if (tasks.length === 0) {
    // 即便 agent 还没产出计划/待办，活跃回合也不该显示「暂无任务」
    // （UI 审计 #8：运行中会话零反馈）。
    if (run && isLiveRunStatus(run.status)) {
      return (
        <div
          data-testid="active-run-placeholder"
          className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2"
        >
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-badge-info" />
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${runStatusClass(run.status)}`}>
            {getRunUiStatusLabel(run.status, t)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{run.phase}</span>
          {run.activeToolName && (
            <span className="truncate text-[11px] text-zinc-500">{run.activeToolName}</span>
          )}
        </div>
      );
    }
    return <EmptyState variant="inline" text={rw.noTasks} />;
  }

  const sessionTask = tasks.find((task) => task.scope === 'session') || null;
  const backgroundTasks = tasks.filter((task) => task.scope !== 'session');

  return (
    <div className="space-y-2">
      {sessionTask ? (
        <TaskRecordRow task={sessionTask} run={run} primary showOutputRefs={showOutputRefs} />
      ) : (
        <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-2.5 py-2 text-[11px] text-zinc-600">
          {rw.noTasksInConversation}
        </div>
      )}

      {backgroundTasks.length > 0 && (
        <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-2.5 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span
              className="text-[10px] tracking-wide text-zinc-500"
              title={rw.otherTasksHint}
            >
              {rw.backgroundTasks}
            </span>
            <span className="text-[10px] text-zinc-600">{backgroundTasks.length}</span>
          </div>
          <div className="space-y-1.5">
            {backgroundTasks.slice(0, 3).map((task) => (
              <TaskRecordRow key={task.id} task={task} showOutputRefs={showOutputRefs} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const SubagentRunRows = ({ subagents }: { subagents: SubagentRunView[] }) => {
  const { t } = useI18n();
  if (subagents.length === 0) return <EmptyState variant="inline" text={t.taskStatusPanels.runWorkbench.noSubagents} />;

  return (
    <div className="space-y-1.5">
      {subagents.map((agent) => (
        <div
          key={agent.id}
          className="min-w-0 rounded-md bg-black/10 px-2.5 py-2"
          data-testid="subagent-run-row"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`text-[10px] ${subagentStatusClass(agent.status)}`}>
              {getLongTaskStatusLabel(agent.status)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
              {agent.role}
            </span>
            {agent.model && (
              <span
                className="max-w-[120px] shrink truncate rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                title={agent.model}
                data-testid="subagent-model-tag"
              >
                {agent.model}
              </span>
            )}
          </div>
          {(agent.lastOutput || agent.inputSummary) && (
            <div className="mt-1 truncate text-[11px] text-zinc-500">
              {agent.lastOutput || agent.inputSummary}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const TaskRecordRow = ({
  task,
  run,
  primary = false,
  showOutputRefs = true,
}: {
  task: TaskRecord;
  run?: RunUiState | null;
  primary?: boolean;
  showOutputRefs?: boolean;
}) => {
  const { t } = useI18n();
  const rail = deriveTaskRailView(task, run);
  const dependencySummary = dependencySummaryLabel(rail.dependencySummary, t);
  const rw = t.taskStatusPanels.runWorkbench;
  const detailLabel = task.status === 'blocked'
    ? rw.reason
    : task.status === 'completed'
      ? rw.result
      : rw.currentAction;

  return (
    <div
      className={`min-w-0 rounded-md bg-black/10 px-2 py-1.5 ${primary ? 'border border-white/[0.07]' : ''}`}
      data-testid="task-record-row"
      data-task-status={rail.status}
    >
      {rail.mode === 'checklist' ? (
        <TaskChecklistHeader rail={rail} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">{getTaskScopeLabel(task.scope, t)}</span>
          <span
            className={`text-[10px] ${getTaskStatusClass(rail.status)}`}
            data-testid="task-record-status"
            data-task-status={rail.status}
          >
            {getTaskStatusLabel(rail.status, t)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{rail.title}</span>
        </div>
      )}

      {dependencySummary && (
        <div
          className="mt-1 truncate text-[10px] text-zinc-500"
          data-testid="task-dependency-summary"
          title={dependencySummary}
        >
          {dependencySummary}
        </div>
      )}

      {rail.mode === 'checklist' && (
        <div className="mt-2 space-y-1.5">
          {rail.visibleSteps.map((step) => (
            <TaskRailStepRow key={`${step.originalIndex}:${step.title}`} step={step} />
          ))}
        </div>
      )}

      {rail.currentAction && (
        <div className="mt-1 truncate text-[11px] text-zinc-500">{detailLabel}：{rail.currentAction}</div>
      )}

      {showOutputRefs && task.outputRefs && task.outputRefs.length > 0 && (
        <TaskOutputRefRows refs={task.outputRefs} />
      )}
    </div>
  );
};

const TaskChecklistHeader = ({ rail }: { rail: ReturnType<typeof deriveTaskRailView> }) => {
  const { t } = useI18n();
  return (
  <div className="flex min-w-0 items-center gap-2">
    <ListChecks className="h-4 w-4 flex-shrink-0 text-zinc-300" />
    <span
      className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-zinc-100"
      title={rail.title}
    >
      {t.taskStatusPanels.runWorkbench.completedTasks
        .replace('{completed}', String(rail.completed))
        .replace('{total}', String(rail.taskCount))}
    </span>
    <span
      className="sr-only"
      data-testid="task-record-status"
      data-task-status={rail.status}
    >
      {getTaskStatusLabel(rail.status, t)}
    </span>
  </div>
  );
};

function outputRefTone(type: TaskRecordOutputRef['type']): string {
  if (type === 'log') return 'border-badge-info/20 bg-sky-500/10 text-badge-info';
  if (type === 'text' || type === 'report') return 'border-badge-success/20 bg-emerald-500/10 text-badge-success';
  if (type === 'trace' || type === 'replay') return 'border-badge-accent/20 bg-violet-500/10 text-badge-accent';
  return 'border-white/[0.08] bg-white/[0.03] text-zinc-400';
}

function outputRefBadgeLabel(type: TaskRecordOutputRef['type'], t: Translations): string {
  const rw = t.taskStatusPanels.runWorkbench;
  if (type === 'log') return rw.log;
  if (type === 'text') return rw.output;
  if (type === 'report') return rw.report;
  if (type === 'trace') return 'Trace';
  if (type === 'replay') return 'Replay';
  if (type === 'url') return rw.link;
  return rw.artifact;
}

const TaskOutputRefRows = ({ refs }: { refs: TaskRecordOutputRef[] }) => {
  return (
  <div className="mt-1.5 space-y-1" data-testid="task-output-refs">
    {refs.map((ref) => (
      <TaskOutputRefRow key={ref.id} outputRef={ref} />
    ))}
  </div>
  );
};

type LogReadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; content: string; truncated: boolean; size: number }
  | { status: 'error' };

const TaskOutputRefRow = ({ outputRef: ref }: { outputRef: TaskRecordOutputRef }) => {
  const { t } = useI18n();
  const rw = t.taskStatusPanels.runWorkbench;
  const [expanded, setExpanded] = useState(false);
  const [logState, setLogState] = useState<LogReadState>({ status: 'idle' });
  const canReadLog = ref.type === 'log' && Boolean(ref.taskId);

  const loadLog = async (): Promise<void> => {
    if (!ref.taskId) return;
    setLogState({ status: 'loading' });
    try {
      const response = await typedInvokeDomain(BackgroundTaskSchemas.READ_TASK_LOG, {
        action: 'readTaskLog',
        payload: { taskId: ref.taskId, refId: ref.id },
      });
      if (!response.success) {
        setLogState({ status: 'error' });
        return;
      }
      setLogState({ status: 'loaded', ...response.data });
    } catch {
      setLogState({ status: 'error' });
    }
  };

  const toggleLog = (): void => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (logState.status === 'idle') void loadLog();
  };

  return (
    <div
      className="min-w-0 rounded border border-white/[0.04] bg-white/[0.015] px-2 py-1"
      title={ref.pathOrUrl || ref.label}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${outputRefTone(ref.type)}`}>
          {outputRefBadgeLabel(ref.type, t)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300">{ref.label}</span>
        {ref.type === 'log' && ref.size === 0 ? (
          <span
            className="flex-shrink-0 rounded border border-badge-warning/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-badge-warning"
            data-testid="task-output-ref-empty"
          >
            {rw.noOutput}
          </span>
        ) : ref.pathOrUrl && (
          <span className="min-w-0 flex-[1.5] truncate text-[10px] text-zinc-600">{ref.pathOrUrl}</span>
        )}
        {canReadLog && (
          <button /* ds-allow:button: 日志展开/收起超小尺寸文本按钮（px-1 py-0.5 text-[10px]），primitive 最小 sm 仍更大 */
            type="button"
            className="flex flex-shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-badge-info hover:bg-sky-500/10"
            aria-expanded={expanded}
            onClick={toggleLog}
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? rw.hideLog : rw.viewLog}
          </button>
        )}
      </div>

      {canReadLog && expanded && (
        <div className="mt-1.5 border-t border-white/[0.05] pt-1.5" data-testid="task-log-viewer">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[9px] text-zinc-600">
              {logState.status === 'loaded' && logState.truncated ? rw.logTruncated : ''}
            </span>
            <button /* ds-allow:button: 日志刷新超小尺寸文本按钮（px-1 py-0.5 text-[9px]），primitive 最小 sm 仍更大 */
              type="button"
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[9px] text-zinc-400 hover:bg-white/[0.05] disabled:opacity-50"
              disabled={logState.status === 'loading'}
              onClick={() => void loadLog()}
            >
              <RefreshCw className={`h-2.5 w-2.5 ${logState.status === 'loading' ? 'animate-spin' : ''}`} />
              {rw.refreshLog}
            </button>
          </div>
          {logState.status === 'loading' && (
            <div className="text-[10px] text-zinc-500">{rw.loadingLog}</div>
          )}
          {logState.status === 'error' && (
            <div className="text-[10px] text-badge-danger" role="alert">{rw.logLoadFailed}</div>
          )}
          {logState.status === 'loaded' && (logState.content.length === 0 ? (
            <div className="text-[10px] text-badge-warning">{rw.noOutput}</div>
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-[10px] text-zinc-300">
              {logState.content}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
};

const TaskRailStepRow = ({ step, muted = false }: { step: TaskRailStepView; muted?: boolean }) => {
  const { t, language } = useI18n();
  const blockedByTitles = step.blockedByTitles?.length
    ? joinDependencyTitles(step.blockedByTitles, language)
    : null;
  const blockedTaskTitles = step.blockedTaskTitles?.length
    ? joinDependencyTitles(step.blockedTaskTitles, language)
    : null;
  const waitingHint = step.blockedByTitles?.length
    ? formatTemplate(t.taskPanel.taskDependencyWaiting, { tasks: blockedByTitles ?? '' })
    : null;
  const unlocksHint = step.blockedTaskTitles?.length
    ? formatTemplate(t.taskPanel.taskDependencyUnlocks, { tasks: blockedTaskTitles ?? '' })
    : null;
  // 卡住原因（ADR-050）：优先用 agent 写的人话，它被判定成 raw 日志时退回类别文案。
  // 无论哪条路径，非程序员看到的都不是报错原文。
  const stuckHint = step.blockedReasonCategory
    ? step.blockedReason || t.taskPanel.taskBlockedReason[step.blockedReasonCategory]
    : step.blockedReason || null;

  return (
    <div
      className={`grid min-w-0 grid-cols-[20px_24px_minmax(0,1fr)] items-center gap-2 ${muted ? 'opacity-60' : ''}`}
      data-testid="task-rail-step"
      data-task-status={step.status}
    >
      <span className="flex h-4 w-4 items-center justify-center" title={getTaskStatusLabel(step.status, t)}>
        {step.status === 'completed' ? (
          <CheckCircle2 className="h-4 w-4 fill-zinc-200 text-zinc-950" />
        ) : step.status === 'in_progress' ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-300" />
        ) : step.status === 'blocked' ? (
          <AlertTriangle className="h-3.5 w-3.5 text-badge-danger" />
        ) : step.status === 'cancelled' ? (
          <XCircle className="h-4 w-4 text-zinc-500" />
        ) : (
          <Circle className="h-4 w-4 text-zinc-500" />
        )}
      </span>
      <span className="text-right text-xs tabular-nums text-zinc-500">{step.originalIndex + 1}.</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate text-[13px] leading-5 ${
          step.status === 'completed'
            ? 'text-zinc-500 line-through decoration-zinc-500/80'
            : step.status === 'cancelled'
              ? 'text-zinc-600 line-through decoration-zinc-600/80'
              : 'text-zinc-200'
        }`}>
          {step.title}
        </span>
        {stuckHint && (
          <span
            className="min-w-0 flex-shrink truncate rounded border border-badge-danger/20 bg-red-400/5 px-1 py-0.5 text-[10px] text-badge-danger/85"
            data-testid="task-rail-step-blocked-reason"
            title={stuckHint}
          >
            {stuckHint}
          </span>
        )}
        {waitingHint && (
          <span
            className="min-w-0 flex-shrink truncate rounded border border-badge-warning/15 bg-amber-400/5 px-1 py-0.5 text-[10px] text-badge-warning/80"
            title={waitingHint}
          >
            {waitingHint}
          </span>
        )}
        {unlocksHint && (
          <span
            className="min-w-0 flex-shrink truncate rounded border border-badge-info/15 bg-sky-400/5 px-1 py-0.5 text-[10px] text-badge-info/75"
            title={unlocksHint}
          >
            {unlocksHint}
          </span>
        )}
      </div>
    </div>
  );
};

export const RunTimeline = ({ decisions }: { decisions: LoopDecisionView[] }) => {
  const { t } = useI18n();
  if (decisions.length === 0) return <EmptyState variant="inline" text={t.taskStatusPanels.runWorkbench.noRunEvents} />;

  return (
    <div className="space-y-1.5">
      {decisions.map((decision) => (
        <div key={`${decision.runId}-${decision.step}-${decision.action}`} className="flex gap-2 rounded-md bg-black/10 px-2.5 py-2">
          <div className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.08] text-[10px] text-zinc-500">
            {decision.step}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-200">{decision.action}</span>
              {decision.blockedReason && <AlertTriangle className="h-3 w-3 text-badge-warning" />}
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">{decision.reason}</div>
            {decision.expectedNextAction && (
              <div className="mt-0.5 text-[11px] text-zinc-600">{decision.expectedNextAction}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

function sourceTone(source: ToolCapabilityView['source']): 'skill' | 'connector' | 'mcp' | 'neutral' | 'info' {
  if (source === 'skill') return 'skill';
  if (source === 'connector') return 'connector';
  if (source === 'mcp') return 'mcp';
  if (source === 'computer' || source === 'memory') return 'info';
  return 'neutral';
}

export const ToolDiscoverySummary = ({ tools }: { tools: ToolCapabilityView[] }) => {
  const { t } = useI18n();
  if (tools.length === 0) return <EmptyState variant="inline" text={t.taskStatusPanels.runWorkbench.noToolActivity} />;

  return (
    <div className="space-y-1.5">
      {tools.map((tool) => (
        <div key={tool.id} className="flex items-center gap-2 rounded-md bg-black/10 px-2.5 py-2">
          <WorkbenchPill tone={sourceTone(tool.source)}>{tool.source}</WorkbenchPill>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-zinc-200">{tool.label}</div>
            {/* 同上：工具失败原因也不把 raw 输出怼给用户 */}
            {(tool.blockedReason || tool.blockedReasonCategory) && (
              <div className="truncate text-[11px] text-badge-warning">
                {tool.blockedReason
                  || (tool.blockedReasonCategory ? t.taskPanel.taskBlockedReason[tool.blockedReasonCategory] : '')}
              </div>
            )}
          </div>
          <span className={`text-[10px] ${tool.callable ? 'text-badge-success' : 'text-badge-warning'}`}>
            {tool.callable ? 'callable' : 'blocked'}
          </span>
        </div>
      ))}
    </div>
  );
};

function memoryActionLabel(action: MemoryActivityEvent['action']): string {
  if (action === 'created') return 'created';
  if (action === 'updated') return 'updated';
  if (action === 'deleted') return 'deleted';
  return 'used';
}

function memoryActionClass(action: MemoryActivityEvent['action']): string {
  if (action === 'created') return 'border-badge-success/20 bg-emerald-500/10 text-badge-success';
  if (action === 'updated') return 'border-badge-info/20 bg-sky-500/10 text-badge-info';
  if (action === 'deleted') return 'border-red-500/20 bg-red-500/10 text-badge-danger';
  return 'border-badge-accent/20 bg-violet-500/10 text-badge-accent';
}

interface MemoryActivitySummaryProps {
  activities: MemoryActivityEvent[];
  onOpenActivity?: (activity: MemoryActivityEvent) => void;
}

export const MemoryActivitySummary = ({ activities, onOpenActivity }: MemoryActivitySummaryProps) => {
  const { t } = useI18n();
  if (activities.length === 0) return <EmptyState variant="inline" text={t.taskStatusPanels.runWorkbench.noMemoryActivity} />;

  return (
    <div className="space-y-1.5">
      {activities.map((activity) => {
        const content = (
          <>
            <Brain className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-badge-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${memoryActionClass(activity.action)}`}>
                  {memoryActionLabel(activity.action)}
                </span>
                {activity.confidence !== undefined && (
                  <span className="text-[10px] text-zinc-600">{Math.round(activity.confidence * 100)}%</span>
                )}
              </div>
              <div className="truncate text-xs text-zinc-200">{activity.title}</div>
              <div className="truncate text-[11px] text-zinc-500">{activity.reason}</div>
              {activity.sourceSessionId && (
                <div className="truncate text-[11px] text-zinc-600">source {activity.sourceSessionId}</div>
              )}
              {(activity.filename || activity.targetPath) && (
                <div className="truncate text-[11px] text-zinc-600">{activity.filename || activity.targetPath}</div>
              )}
            </div>
            {onOpenActivity && (
              <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-badge-accent" />
            )}
          </>
        );
        const className = `group flex w-full items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-left ${
          onOpenActivity ? 'hover:bg-violet-500/10 focus:outline-hidden' : ''
        }`;

        return onOpenActivity ? (
          <button
            key={`${activity.runId}-${activity.memoryId}-${activity.action}`}
            type="button"
            data-testid="memory-activity-row"
            onClick={() => onOpenActivity(activity)}
            className={className}
            title={t.taskStatusPanels.runWorkbench.openMemoryDetails}
          >
            {content}
          </button>
        ) : (
          <div
            key={`${activity.runId}-${activity.memoryId}-${activity.action}`}
            data-testid="memory-activity-row"
            className={className}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
};
