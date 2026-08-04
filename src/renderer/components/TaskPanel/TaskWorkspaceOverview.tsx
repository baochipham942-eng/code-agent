import React, { useMemo, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { CONFIG_DIR_DEV, CONFIG_DIR_NEW } from '@shared/constants/configDir';
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

// ── 准入规则（2026-08-04 追加拍板）──────────────────────────────────────
// 唯一准入判据 = 本次任务实际发生过调用/读写；「可用/已加载/已连接/被列出」不进。
// 工具视图 id 形态区分来源：`tool:<name>` 是真实 tool_call 投影；`<kind>:<id>`
// 只是能力范围（scope）里被列出/选中的条目。

/** 内部数据目录（配置目录名与 shared 常量同源，renderer 可安全引用） */
const INTERNAL_CONTEXT_DIR_MARKERS = [
  `/${CONFIG_DIR_NEW}/`,
  `/${CONFIG_DIR_DEV}/`,
];

/** 内部工件路径：app 数据目录内部文件、tool-result blob（spec §模块三 文件类反例） */
function isInternalContextPath(path?: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/');
  if (INTERNAL_CONTEXT_DIR_MARKERS.some((marker) => normalized.includes(marker))) return true;
  const name = normalized.split('/').filter(Boolean).pop() || '';
  return /tool[-_]?result/i.test(name);
}

/** 原始内部 ID（tool-result-tool-775064011… 这类）不得上屏（工单 A.5） */
function looksLikeInternalId(label: string): boolean {
  return /tool[-_ ]?(result|call)/i.test(label) || /\d{9,}/.test(label);
}

/** 解析不出人话名字时兜底「未命名输出/未知能力」，绝不兜底 ID */
function humanContextLabel(label: string | undefined, fallback: string): string {
  const trimmed = label?.trim() ?? '';
  if (!trimmed || looksLikeInternalId(trimmed)) return fallback;
  return trimmed;
}

/** MCP 按 server 去重：tool:mcp__<server>__<tool> → server 名 */
function mcpServerName(toolId: string, label: string): string {
  const name = toolId.startsWith('tool:') ? toolId.slice('tool:'.length) : label;
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1];
    if (server) return server;
  }
  return label;
}

export interface OverviewContextFallbacks {
  unnamedOutput: string;
  unknownCapability: string;
}

export function buildOverviewContextRows(args: {
  tools: ToolCapabilityView[];
  memoryActivities: MemoryActivityEvent[];
  contextItems: FileContextItem[];
  fallbacks: OverviewContextFallbacks;
}): OverviewContextRow[] {
  const rows = new Map<string, OverviewContextRow>();
  const { fallbacks } = args;

  // 文件：真实 Read/Write/Edit 过的用户可辨认文件 + 用户给的附件。
  // 倒序遍历 = 类内最近使用在前；同一路径读又写只出一行（动作小标合并回时序）。
  for (const item of [...args.contextItems].reverse()) {
    if (item.bucket !== 'files' || item.failed) continue;
    if (isInternalContextPath(item.path)) continue;
    const identity = item.path || item.label;
    const key = `file:${identity}`;
    const existing = rows.get(key);
    if (existing) {
      if (item.detail && existing.detail !== item.detail) {
        existing.detail = existing.detail
          ? `${item.detail} / ${existing.detail}`
          : item.detail;
      }
      continue;
    }
    rows.set(key, {
      id: key,
      kind: 'file',
      label: humanContextLabel(item.label, fallbacks.unnamedOutput),
      detail: item.detail,
    });
  }

  // 技能：contextItems 的 rules 行只由真实 Skill 调用产生，label 是技能名；
  // 仅出现在可用列表/被搜索到的不进，激活失败（failed）的不进。
  for (const item of [...args.contextItems].reverse()) {
    if (item.bucket !== 'rules' || item.source !== 'tool' || item.failed) continue;
    const key = `skill:${item.label}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      id: key,
      kind: 'skill',
      label: humanContextLabel(item.label, fallbacks.unknownCapability),
    });
  }

  // MCP / Connector / Computer：真实调用过（tool_call 投影）或被拒/失败（标黄保留）；
  // 已连接但零调用的不进。memory 走 memoryActivities（带动作小标），不在此列。
  for (const tool of [...args.tools].reverse()) {
    const kind = contextKindFromTool(tool.source);
    if (!kind || kind === 'skill' || kind === 'memory') continue;
    const invoked = tool.id.startsWith('tool:');
    if (!invoked && tool.callable) continue;
    const label = humanContextLabel(
      kind === 'mcp' ? mcpServerName(tool.id, tool.label) : tool.label,
      fallbacks.unknownCapability,
    );
    const key = `${kind}:${label}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      id: key,
      kind,
      label,
      detail: tool.callable ? undefined : tool.blockedReason || 'blocked',
      blocked: !tool.callable,
    });
  }

  // 记忆：本次任务真实读取/写入的条目，带 created/updated/used 动作小标
  for (const activity of [...args.memoryActivities].reverse()) {
    const key = `memory:${activity.memoryId}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      id: key,
      kind: 'memory',
      label: humanContextLabel(activity.filename || activity.title, fallbacks.unknownCapability),
      detail: memoryActionLabel(activity.action),
    });
  }

  return Array.from(rows.values());
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
      fallbacks: {
        unnamedOutput: t.workbenchTabs.overviewUnnamedOutput,
        unknownCapability: t.workbenchTabs.overviewUnknownCapability,
      },
    }),
    [
      runWorkbench.memoryActivities,
      runWorkbench.tools,
      statusRail.context.items,
      t.workbenchTabs.overviewUnnamedOutput,
      t.workbenchTabs.overviewUnknownCapability,
    ],
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
