import React, { useMemo, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore';
import { useTaskStore } from '../../stores/taskStore';
import { useCurrentTurnArtifactOwnership } from '../../hooks/useCurrentTurnArtifactOwnership';
import { useRunWorkbenchModel } from '../../hooks/useRunWorkbenchModel';
import {
  useStatusRailModel,
  type StatusRailContextModel,
} from '../../hooks/useStatusRailModel';
import { useWorkspacePreviewModel } from '../../hooks/useWorkspacePreviewModel';
import type {
  MemoryActivityEvent,
  TaskRecord,
  ToolCapabilityView,
} from '../../types/runWorkbench';
import { useI18n } from '../../hooks/useI18n';
import { EmptyState } from '../primitives';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';
import { AgentTreeView } from '../features/agentTree/AgentTreeView';
import { Card } from './Card';
import { OverviewRunHeader } from './OverviewRunHeader';
import { OverviewSteeringQueue } from './OverviewSteeringQueue';
import {
  CurrentTurnArtifactOwnershipCard,
  OutputFileRows,
} from './OutputArtifactRows';
import { TaskDashboardSummary } from './RunWorkbenchCards';

// 后台任务状态台账读取失败时的独立失败块（替代任务摘要，不静默吞掉这个状态）。
// 摘自已删除的 TaskMonitor.tsx——readFailure/requestStatusReadRetry 在全仓只有
// 这一个消费点，删组件前把这份唯一的数据消费契约搬到 Overview 诊断二级承接。
function StatusReadFailureBanner({
  isLoading,
  onRetry,
  onCancel,
  canCancel,
}: {
  isLoading: boolean;
  onRetry: () => void;
  onCancel: () => Promise<void>;
  canCancel: boolean;
}) {
  const { t } = useI18n();
  const m = t.taskStatusPanels.monitor;
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);

  const handleCancel = async (): Promise<void> => {
    if (cancelling || isLoading || !canCancel) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      await onCancel();
    } catch {
      setCancelFailed(true);
    } finally {
      setCancelling(false);
    }
  };

  const busy = isLoading || cancelling;

  return (
    <div
      className="rounded-md border border-badge-warning/20 bg-amber-500/[0.06] px-2.5 py-2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-badge-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-badge-warning">{m.statusReadFailed}</div>
          <div className="mt-0.5 text-[11px] text-badge-warning/70">{m.statusReadFailedHint}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-badge-warning/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-badge-warning transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={m.retryStatusRead}
        >
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          <span>{isLoading ? m.retryingStatusRead : m.retryStatusRead}</span>
        </button>
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={busy || !canCancel}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/[0.14] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={m.cancelTask}
        >
          {cancelling && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          <span>{cancelling ? m.cancellingTask : m.cancelTask}</span>
        </button>
      </div>
      {cancelFailed && (
        <div className="mt-2 text-[11px] text-badge-danger" role="alert">{m.cancelTaskFailed}</div>
      )}
    </div>
  );
}

export interface TodoProgressSummary {
  completed: number;
  total: number;
  label?: string;
}

export function summarizeTodoProgress(tasks: TaskRecord[]): TodoProgressSummary {
  const sessionTask = tasks.find((task) => task.scope === 'session');
  const sourceSteps = sessionTask?.steps
    ?? tasks.flatMap((task) => task.steps);
  const actionableSteps = sourceSteps.filter((step) => step.status !== 'cancelled');
  const completed = actionableSteps.filter((step) => step.status === 'completed').length;
  const total = actionableSteps.length;
  return {
    completed,
    total,
    label: total > 0 ? `${completed}/${total}` : undefined,
  };
}

type OverviewContextKind =
  | 'skill'
  | 'mcp'
  | 'connector'
  | 'memory'
  | 'computer'
  | 'file';

export interface OverviewContextRow {
  id: string;
  kind: OverviewContextKind;
  label: string;
  detail?: string;
  blocked?: boolean;
}

type FileContextItem = StatusRailContextModel['items'][number];

function contextKindFromTool(source: ToolCapabilityView['source']): OverviewContextKind | null {
  if (source === 'skill') return 'skill';
  if (source === 'mcp') return 'mcp';
  if (source === 'connector') return 'connector';
  if (source === 'memory') return 'memory';
  if (source === 'computer') return 'computer';
  return null;
}

function memoryActionLabel(action: MemoryActivityEvent['action']): string {
  if (action === 'created') return 'created';
  if (action === 'updated') return 'updated';
  if (action === 'deleted') return 'deleted';
  return 'used';
}

export function buildOverviewContextRows(args: {
  tools: ToolCapabilityView[];
  memoryActivities: MemoryActivityEvent[];
  contextItems: FileContextItem[];
}): OverviewContextRow[] {
  const rows = new Map<string, OverviewContextRow>();

  for (const tool of args.tools) {
    const kind = contextKindFromTool(tool.source);
    // Bash、Read 等执行流水属于 Todo 的当前动作，不再作为高层上下文重复展示。
    if (!kind) continue;
    const key = `${kind}:${tool.id}`;
    rows.set(key, {
      id: key,
      kind,
      label: tool.label,
      detail: tool.callable ? undefined : tool.blockedReason || 'blocked',
      blocked: !tool.callable,
    });
  }

  for (const activity of args.memoryActivities) {
    const key = `memory:${activity.memoryId}`;
    rows.set(key, {
      id: key,
      kind: 'memory',
      label: activity.filename || activity.title,
      detail: memoryActionLabel(activity.action),
    });
  }

  for (const item of args.contextItems) {
    if (item.bucket !== 'files') continue;
    const identity = item.path || item.label;
    const key = `file:${identity}`;
    const existing = rows.get(key);
    if (existing) {
      if (item.detail && existing.detail !== item.detail) {
        existing.detail = existing.detail
          ? `${existing.detail} / ${item.detail}`
          : item.detail;
      }
      continue;
    }
    rows.set(key, {
      id: key,
      kind: 'file',
      label: item.label,
      detail: item.detail,
    });
  }

  return Array.from(rows.values()).slice(0, 12);
}

function contextTone(kind: OverviewContextKind): 'skill' | 'connector' | 'mcp' | 'info' | 'neutral' {
  if (kind === 'skill') return 'skill';
  if (kind === 'connector') return 'connector';
  if (kind === 'mcp') return 'mcp';
  if (kind === 'memory' || kind === 'computer') return 'info';
  return 'neutral';
}

function contextKindLabel(kind: OverviewContextKind): string {
  if (kind === 'skill') return 'Skill';
  if (kind === 'mcp') return 'MCP';
  if (kind === 'connector') return 'Connector';
  if (kind === 'memory') return 'Memory';
  if (kind === 'computer') return 'Computer';
  return 'File';
}

function ContextRows({ rows }: { rows: OverviewContextRow[] }) {
  return (
    <div className="space-y-0.5" data-testid="overview-context-rows">
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-white/[0.025]"
          data-testid="overview-context-row"
        >
          <WorkbenchPill tone={contextTone(row.kind)}>
            {contextKindLabel(row.kind)}
          </WorkbenchPill>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={row.label}>
            {row.label}
          </span>
          {row.detail && (
            <span className={`max-w-[110px] truncate text-[10px] ${
              row.blocked ? 'text-badge-warning' : 'text-zinc-600'
            }`}>
              {row.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export interface TaskWorkspaceOverviewProps {
  agentTreeSnapshot?: AgentTreeSnapshot | null;
}

export const TaskWorkspaceOverview: React.FC<TaskWorkspaceOverviewProps> = ({
  agentTreeSnapshot,
}) => {
  const { t } = useI18n();
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const openFilePreview = useAppStore((state) => state.openPreview);
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const setSelectedWorkspacePreviewId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const readFailure = useBackgroundTaskStore((state) => state.readFailure);
  const backgroundTasksLoading = useBackgroundTaskStore((state) => state.isLoading);
  const requestStatusReadRetry = useBackgroundTaskStore((state) => state.requestStatusReadRetry);
  const cancelTask = useTaskStore((state) => state.cancelTask);
  const statusRail = useStatusRailModel();
  const runWorkbench = useRunWorkbenchModel();
  const currentTurnArtifactOwnership = useCurrentTurnArtifactOwnership();
  const workspacePreviewItems = useWorkspacePreviewModel();

  const todoProgress = useMemo(
    () => summarizeTodoProgress(runWorkbench.tasks),
    [runWorkbench.tasks],
  );
  const contextRows = useMemo(
    () => buildOverviewContextRows({
      tools: runWorkbench.tools,
      memoryActivities: runWorkbench.memoryActivities,
      contextItems: statusRail.context.items,
    }),
    [runWorkbench.memoryActivities, runWorkbench.tools, statusRail.context.items],
  );
  const agentCount = agentTreeSnapshot?.nodes.length ?? 0;
  const artifactCount = currentTurnArtifactOwnership
    ? currentTurnArtifactOwnership.artifactOwnership.length
    : statusRail.outputs.count;

  const openPreview = (itemId?: string | null) => {
    openWorkspacePreview(itemId ?? workspacePreviewItems[0]?.id ?? null);
  };
  const openFile = (path: string) => {
    // 概览只负责选产物；文件内容由右栏原生 preview tab 承载。
    // 先清掉旧 workspace-preview 选择，用户切回概览时仍然看到三段工作台。
    setSelectedWorkspacePreviewId(null);
    openFilePreview(path);
  };

  return (
    // T1 主路径顺序：Run header（进度与干预）→ 队列 → Todo → 产物 → 诊断（二级折叠）。
    <div className="space-y-3" data-testid="task-workspace-overview">
      <OverviewRunHeader />

      <OverviewSteeringQueue />

      <Card
        title={t.workbenchTabs.overviewTodosLabel}
        storageKey="overview-todos"
        count={readFailure ? undefined : todoProgress.label}
        highlight={runWorkbench.tasks.some((task) => task.status === 'blocked')}
      >
        {readFailure ? (
          <StatusReadFailureBanner
            isLoading={backgroundTasksLoading}
            onRetry={requestStatusReadRetry}
            onCancel={() => {
              if (!currentSessionId) return Promise.resolve();
              return cancelTask(currentSessionId);
            }}
            canCancel={Boolean(currentSessionId)}
          />
        ) : (
          <TaskDashboardSummary
            tasks={runWorkbench.tasks}
            run={runWorkbench.run}
            showOutputRefs={false}
          />
        )}
      </Card>

      <Card
        title={t.workbenchTabs.overviewArtifactsLabel}
        storageKey="overview-artifacts"
        count={artifactCount > 0 ? String(artifactCount) : undefined}
      >
        {currentTurnArtifactOwnership ? (
          <CurrentTurnArtifactOwnershipCard
            artifactOwnership={currentTurnArtifactOwnership.artifactOwnership}
            previewItems={workspacePreviewItems}
            workingDirectory={workingDirectory}
            onOpenPreview={openPreview}
            onOpenFile={openFile}
          />
        ) : statusRail.outputs.count > 0 ? (
          <OutputFileRows
            files={statusRail.outputs.files}
            previewItems={workspacePreviewItems}
            onOpenPreview={openPreview}
            onOpenFile={openFile}
          />
        ) : (
          <EmptyState variant="inline" text={t.previewWorkspace.workspacePreview.noArtifactsYet} />
        )}
      </Card>

      {/* 诊断二级（T1）：AgentTree / 能力路由证据 / 上下文行对 power user 仍有价值，
          内容一条不删，只是默认折叠、不再抢主视线（调研 §4.5）。 */}
      <Card
        title={t.workbenchTabs.overviewDiagnosticsLabel}
        storageKey="overview-diagnostics"
        defaultExpanded={false}
        count={String(contextRows.length + agentCount)}
      >
        <div className="space-y-2" data-testid="overview-diagnostics-body">
          <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">
            {t.workbenchTabs.overviewContextLabel}
          </div>
          <AgentTreeView snapshot={agentTreeSnapshot} />
          {contextRows.length > 0 ? (
            <ContextRows rows={contextRows} />
          ) : (
            <EmptyState variant="inline" text={t.workbenchTabs.overviewContextEmpty} />
          )}
        </div>
      </Card>
    </div>
  );
};
