// ============================================================================
// TaskWorkspaceOverview —— 概览四模块 · 任务上下文面板（2026-08-04 拍板二/三）
// ----------------------------------------------------------------------------
// 四个一级模块竖向堆叠，各回答一个用户问题：
//   任务（在干什么：细进度线）/ Todo（干到哪了）/ 上下文（用了什么）/
//   产物（给了我什么：完成态收拢缩略行）。
// 诊断 UI（AgentTree / 能力路由证据 / 详情入口）整体删除——数据照常写 DB，仅撤 UI。
// 视觉：无卡片外壳、静态容器零边框（条款 B2），层级靠留白 + 字色阶梯。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { CONFIG_DIR_DEV, CONFIG_DIR_NEW } from '@shared/constants/configDir';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore';
import { useTaskStore } from '../../stores/taskStore';
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
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { useI18n } from '../../hooks/useI18n';
import { humanContextLabel } from '../../utils/overviewLabels';
import { isLiveRunStatus } from '../../utils/overviewRunHeader';
import { OverviewRunHeader } from './OverviewRunHeader';
import { ArtifactThumbStrip } from './OutputArtifactRows';
import { TaskDashboardSummary } from './RunWorkbenchCards';

// 真读取失败（读取异常且确有任务在跑）在 Todo 模块位置内联一行错误 + 重试/取消
// （拍板三后无详情二级可挂）。0 rows ≠ failure：store 侧已不置位，这里再做一层
// 与「任务」模块完成态的互斥——run 非 live 时不允许同屏出现错误横幅
// （2026-08-04 trace session_1785817007068_bb5753c3 实证两者同屏打架）。
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
    <div role="status" aria-live="polite" className="px-0.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-badge-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-badge-warning">{m.statusReadFailed}</div>
          <div className="mt-0.5 text-[11px] text-badge-warning/70">{m.statusReadFailedHint}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-5">
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
        <div className="mt-1.5 pl-5 text-[11px] text-badge-danger" role="alert">{m.cancelTaskFailed}</div>
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

// ── 模块通用小标题：字色阶梯分界，不用分隔线（条款 B2/B4）─────────────────

function ModuleLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 px-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  );
}

// ── 模块三 · 上下文：每项一行 = 类型小标 + 人话名（不套 chip 描边，B2）──────

const CONTEXT_KIND_ORDER: OverviewContextKind[] = [
  'file',
  'skill',
  'mcp',
  'memory',
  'computer',
  'connector',
];

/** 每类最多 5 行，超出收「+N」尾行（点开展开，不滚动） */
const CONTEXT_KIND_CAP = 5;

function ContextRows({ rows }: { rows: OverviewContextRow[] }) {
  const { t } = useI18n();
  const wt = t.workbenchTabs;
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<string>>(new Set());

  const kindLabels: Record<OverviewContextKind, string> = {
    file: wt.overviewContextKindFile,
    skill: wt.overviewContextKindSkill,
    mcp: wt.overviewContextKindMcp,
    connector: wt.overviewContextKindConnector,
    memory: wt.overviewContextKindMemory,
    computer: wt.overviewContextKindComputer,
  };

  const byKind = new Map<OverviewContextKind, OverviewContextRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }

  return (
    <div className="space-y-0.5" data-testid="overview-context-rows">
      {CONTEXT_KIND_ORDER.map((kind) => {
        const list = byKind.get(kind);
        if (!list?.length) return null;
        const isExpanded = expandedKinds.has(kind);
        const visible = isExpanded ? list : list.slice(0, CONTEXT_KIND_CAP);
        const overflow = list.length - visible.length;
        return (
          <React.Fragment key={kind}>
            {visible.map((row) => (
              <div
                key={row.id}
                className="flex min-w-0 items-baseline gap-2 px-0.5 py-0.5"
                data-testid="overview-context-row"
              >
                <span className="w-9 shrink-0 text-[10px] text-zinc-500">
                  {kindLabels[row.kind]}
                </span>
                <span
                  className={`min-w-0 truncate text-xs ${
                    row.blocked ? 'text-badge-warning' : 'text-zinc-300'
                  }`}
                  title={row.label}
                >
                  {row.label}
                </span>
                {row.detail && (
                  <span className={`ml-auto max-w-[110px] shrink-0 truncate text-[10px] ${
                    row.blocked ? 'text-badge-warning' : 'text-zinc-600'
                  }`}>
                    {row.detail}
                  </span>
                )}
              </div>
            ))}
            {overflow > 0 && (
              <button /* ds-allow:button: 「+N」展开尾行是超小文本按钮（text-[10px]），primitive 最小 sm 仍更大 */
                type="button"
                data-testid={`overview-context-more-${kind}`}
                className="px-0.5 pl-11 text-[10px] text-zinc-500 hover:text-zinc-300"
                aria-label={wt.overviewContextShowMore.replace('{count}', String(overflow))}
                onClick={() => setExpandedKinds((prev) => new Set(prev).add(kind))}
              >
                +{overflow}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export const TaskWorkspaceOverview: React.FC = () => {
  const { t } = useI18n();
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const openFilePreview = useAppStore((state) => state.openPreview);
  const openContentPreview = useAppStore((state) => state.openContentPreview);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const readFailure = useBackgroundTaskStore((state) => state.readFailure);
  const backgroundTasksLoading = useBackgroundTaskStore((state) => state.isLoading);
  const requestStatusReadRetry = useBackgroundTaskStore((state) => state.requestStatusReadRetry);
  const cancelTask = useTaskStore((state) => state.cancelTask);
  const statusRail = useStatusRailModel();
  const runWorkbench = useRunWorkbenchModel();
  const workspacePreviewItems = useWorkspacePreviewModel();

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

  const runLive = isLiveRunStatus(runWorkbench.run.status);
  // 「确有任务在跑」才配谈读取失败：0 rows（没有任务）是空态不是失败（C.11）
  const hasActiveTasks = runWorkbench.tasks.some((task) => task.status === 'in_progress');
  const showReadFailure = Boolean(readFailure) && runLive && hasActiveTasks;
  const showTodoModule = showReadFailure || runWorkbench.tasks.length > 0;

  // Session 口径：产物跨全部 run 聚合；workspacePreviewItems 与当前会话 messages 同源，
  // 不再让最后一轮 ownership 覆盖前几轮产物。
  const artifactItems: TurnArtifactOwnershipItem[] = useMemo(() => {
    return workspacePreviewItems.map((item) => ({
      kind: item.file ? 'file' as const : 'artifact' as const,
      label: item.title,
      path: item.file?.path,
      ownerKind: item.source.kind === 'tool' ? 'tool' as const : 'assistant' as const,
      ownerLabel: item.source.label || '',
    }));
  }, [workspacePreviewItems]);
  // 跑中不铺产物列表；完成/终态收拢为一排缩略行（spec §模块四）
  const showArtifacts = !runLive && artifactItems.length > 0;

  const openPreview = (item: (typeof workspacePreviewItems)[number]) => {
    if (item.file?.path) {
      openFilePreview(item.file.path);
      return;
    }
    const content = item.content?.html
      ?? item.content?.json
      ?? item.content?.text
      ?? item.content?.diff
      ?? item.content?.summary;
    if (!content) return;
    const format = item.content?.html
      ? 'html' as const
      : item.content?.json
        ? 'json' as const
        : item.content?.text || item.content?.summary
          ? 'markdown' as const
          : 'text' as const;
    openContentPreview({ id: item.id, title: item.title, content, format });
  };
  const openFile = (path: string) => {
    openFilePreview(path);
  };

  return (
    <div className="space-y-4" data-testid="task-workspace-overview">
      {/* 模块一 · 任务：细进度线一行 */}
      <section data-module="task" aria-label={t.workbenchTabs.overviewProgressLabel}>
        <OverviewRunHeader />
      </section>

      {/* 模块二 · Todo：计划步骤提为一级；无 TODO 整个模块不渲染 */}
      {showTodoModule && (
        <section
          data-module="todo"
          data-testid="overview-todo-module"
          aria-label={t.workbenchTabs.overviewTodosLabel}
        >
          <ModuleLabel>{t.workbenchTabs.overviewTodosLabel}</ModuleLabel>
          {showReadFailure ? (
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
        </section>
      )}

      {/* 模块三 · 上下文：本次任务实际用到的文件/技能/MCP/记忆（准入规则过滤） */}
      {contextRows.length > 0 && (
        <section
          data-module="context"
          data-testid="overview-context-module"
          aria-label={t.workbenchTabs.overviewContextLabel}
        >
          <ModuleLabel>{t.workbenchTabs.overviewContextLabel}</ModuleLabel>
          <ContextRows rows={contextRows} />
        </section>
      )}

      {/* 模块四 · 产物：完成态收拢缩略行，点击一步直达原生 preview tab */}
      {showArtifacts && (
        <section
          data-module="artifacts"
          data-testid="overview-artifacts-module"
          aria-label={t.workbenchTabs.overviewArtifactsLabel}
        >
          <ModuleLabel>{t.workbenchTabs.overviewArtifactsLabel}</ModuleLabel>
          <ArtifactThumbStrip
            items={artifactItems}
            previewItems={workspacePreviewItems}
            workingDirectory={workingDirectory}
            onOpenPreview={openPreview}
            onOpenFile={openFile}
            unnamedLabel={t.workbenchTabs.overviewUnnamedOutput}
          />
        </section>
      )}
    </div>
  );
};
