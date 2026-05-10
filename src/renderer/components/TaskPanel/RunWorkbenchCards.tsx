import { useState } from 'react';
import type React from 'react';
import { AlertTriangle, ArrowUpRight, Brain, Radio } from 'lucide-react';
import { CardEmptyState as EmptyState } from './Card';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';
import type {
  LoopDecisionView,
  MemoryActivityEvent,
  RunWorkbenchModel,
  RunUiState,
  RunUiStatus,
  TaskRecord,
  ToolCapabilityView,
} from '../../types/runWorkbench';
import {
  deriveTaskRailView,
  type TaskRailStepView,
} from '../../utils/taskRailPresentation';

function runStatusClass(status: RunUiStatus): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
    case 'waiting_approval':
    case 'using_tools':
    case 'verifying':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
    case 'blocked':
    case 'cancelled':
      return 'border-red-500/20 bg-red-500/10 text-red-300';
    case 'planning':
    case 'running':
    default:
      return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
  }
}

interface RunOverviewProps {
  model: RunWorkbenchModel;
  onOpenMemory?: () => void;
}

export const RunOverview = ({ model, onOpenMemory }: RunOverviewProps) => {
  const { run, memoryActivities } = model;
  const isCompleted = run.status === 'completed';

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2">
        {isCompleted ? (
          <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400/50" />
        ) : (
          <Radio className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sky-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isCompleted ? (
              <span className="truncate text-xs text-zinc-300">{run.phase}</span>
            ) : (
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${runStatusClass(run.status)}`}>
                {run.status}
              </span>
            )}
            {run.activeToolName && (
              <span className="truncate text-[11px] text-zinc-500">{run.activeToolName}</span>
            )}
          </div>
          {!isCompleted && (
            <div className="mt-1 truncate text-xs text-zinc-200">{run.phase}</div>
          )}
          {run.blockedReason && (
            <div className="mt-1 text-[11px] text-amber-300">{run.blockedReason}</div>
          )}
        </div>
      </div>

      {memoryActivities.length > 0 && onOpenMemory && (
        <button
          type="button"
          onClick={onOpenMemory}
          data-testid="run-overview-memory-link"
          className="text-[11px] text-zinc-500 underline-offset-2 hover:text-violet-300 hover:underline"
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
      return 'text-sky-300';
    case 'done':
      return 'text-emerald-300';
    case 'blocked':
      return 'text-red-300';
    default:
      return 'text-zinc-500';
  }
}

function getTaskStatusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'done':
      return '完成';
    case 'blocked':
      return '阻塞';
    default:
      return '待开始';
  }
}

function getStepDotClass(status: TaskRailStepView['status']): string {
  switch (status) {
    case 'done':
      return 'border-emerald-400/30 bg-emerald-400/20 text-emerald-300';
    case 'blocked':
      return 'border-red-400/30 bg-red-400/15 text-red-300';
    case 'in_progress':
      return 'border-sky-400/40 bg-sky-400/15 text-sky-300';
    default:
      return 'border-white/[0.08] bg-white/[0.02] text-zinc-500';
  }
}

const TASK_SCOPE_LABEL: Record<TaskRecord['scope'], string> = {
  session: '会话',
  global: '后台',
  scheduled: '定时',
};

export const TaskDashboardSummary = ({ tasks, run }: { tasks: TaskRecord[]; run?: RunUiState | null }) => {
  if (tasks.length === 0) return <EmptyState text="暂无任务" />;

  const sessionTask = tasks.find((task) => task.scope === 'session') || null;
  const backgroundTasks = tasks.filter((task) => task.scope !== 'session');

  return (
    <div className="space-y-2">
      {sessionTask ? (
        <TaskRecordRow task={sessionTask} run={run} primary />
      ) : (
        <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-2.5 py-2 text-[11px] text-zinc-600">
          当前会话暂无任务
        </div>
      )}

      {backgroundTasks.length > 0 && (
        <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-2.5 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] tracking-wide text-zinc-500">其他运行</span>
            <span className="text-[10px] text-zinc-600">{backgroundTasks.length}</span>
          </div>
          <div className="space-y-1.5">
            {backgroundTasks.slice(0, 3).map((task) => (
              <TaskRecordRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const TaskRecordRow = ({ task, run, primary = false }: { task: TaskRecord; run?: RunUiState | null; primary?: boolean }) => {
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const rail = deriveTaskRailView(task, run);

  return (
    <div className={`min-w-0 rounded-md bg-black/10 px-2 py-1.5 ${primary ? 'border border-sky-500/10' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">{TASK_SCOPE_LABEL[task.scope]}</span>
        <span className={`text-[10px] ${getTaskStatusClass(rail.status)}`}>{getTaskStatusLabel(rail.status)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{rail.title}</span>
        {rail.mode === 'checklist' && rail.total > 0 && (
          <span className="text-[10px] tabular-nums text-zinc-600">{rail.completed}/{rail.total}</span>
        )}
      </div>

      {rail.mode === 'checklist' && (
        <div className="mt-2 space-y-1">
          {rail.visibleSteps.map((step) => (
            <TaskRailStepRow key={`${step.originalIndex}:${step.title}`} step={step} />
          ))}
          {rail.hiddenPendingCount > 0 && (
            <div className="pl-5 text-[11px] text-zinc-600">还有 {rail.hiddenPendingCount} 项未显示</div>
          )}
          {rail.hiddenCompletedCount > 0 && (
            <button
              type="button"
              onClick={() => setCompletedExpanded((prev) => !prev)}
              className="pl-5 text-left text-[11px] text-zinc-600 hover:text-zinc-400"
            >
              已完成 {rail.hiddenCompletedCount} 项
            </button>
          )}
          {completedExpanded && rail.completedSteps.length > 0 && (
            <div className="space-y-1">
              {rail.completedSteps.map((step) => (
                <TaskRailStepRow key={`${step.originalIndex}:${step.title}:done`} step={step} muted />
              ))}
            </div>
          )}
        </div>
      )}

      {rail.currentAction && (
        <div className="mt-1 truncate text-[11px] text-zinc-500">当前动作：{rail.currentAction}</div>
      )}
    </div>
  );
};

const TaskRailStepRow = ({ step, muted = false }: { step: TaskRailStepView; muted?: boolean }) => (
  <div className={`flex min-w-0 items-center gap-2 ${muted ? 'opacity-60' : ''}`}>
    <span className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border text-[9px] ${getStepDotClass(step.status)}`}>
      {step.status === 'done' ? '✓' : step.status === 'blocked' ? '!' : ''}
    </span>
    <span className={`truncate text-[11px] ${step.status === 'done' ? 'text-zinc-500' : 'text-zinc-300'}`}>
      {step.title}
    </span>
  </div>
);

export const RunTimeline = ({ decisions }: { decisions: LoopDecisionView[] }) => {
  if (decisions.length === 0) return <EmptyState text="暂无运行事件" />;

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
              {decision.blockedReason && <AlertTriangle className="h-3 w-3 text-amber-300" />}
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
  if (tools.length === 0) return <EmptyState text="本轮还没有工具活动" />;

  return (
    <div className="space-y-1.5">
      {tools.map((tool) => (
        <div key={tool.id} className="flex items-center gap-2 rounded-md bg-black/10 px-2.5 py-2">
          <WorkbenchPill tone={sourceTone(tool.source)}>{tool.source}</WorkbenchPill>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-zinc-200">{tool.label}</div>
            {tool.blockedReason && (
              <div className="truncate text-[11px] text-amber-300">{tool.blockedReason}</div>
            )}
          </div>
          <span className={`text-[10px] ${tool.callable ? 'text-emerald-300' : 'text-amber-300'}`}>
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
  if (action === 'created') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
  if (action === 'updated') return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
  if (action === 'deleted') return 'border-red-500/20 bg-red-500/10 text-red-300';
  return 'border-violet-500/20 bg-violet-500/10 text-violet-300';
}

interface MemoryActivitySummaryProps {
  activities: MemoryActivityEvent[];
  onOpenActivity?: (activity: MemoryActivityEvent) => void;
}

export const MemoryActivitySummary = ({ activities, onOpenActivity }: MemoryActivitySummaryProps) => {
  if (activities.length === 0) return <EmptyState text="本轮还没有记忆活动" />;

  return (
    <div className="space-y-1.5">
      {activities.map((activity) => {
        const content = (
          <>
            <Brain className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-300" />
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
              <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-violet-300" />
            )}
          </>
        );
        const className = `group flex w-full items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-left ${
          onOpenActivity ? 'hover:bg-violet-500/10 focus:outline-none focus:ring-1 focus:ring-violet-500/30' : ''
        }`;

        return onOpenActivity ? (
          <button
            key={`${activity.runId}-${activity.memoryId}-${activity.action}`}
            type="button"
            data-testid="memory-activity-row"
            onClick={() => onOpenActivity(activity)}
            className={className}
            title="打开记忆详情"
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
