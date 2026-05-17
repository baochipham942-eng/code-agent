import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  TimerReset,
  Wrench,
} from 'lucide-react';
import type { CronJobDefinition } from '@shared/contract';
import {
  IPC_DOMAINS,
  type ConnectorStatusSummary,
  type NativeConnectorInventoryItem,
} from '@shared/ipc';
import { useCronStore } from '../../../stores/cronStore';
import { useAppStore } from '../../../stores/appStore';
import ipcService from '../../../services/ipcService';
import { useWorkbenchCapabilityRegistry } from '../../../hooks/useWorkbenchCapabilityRegistry';
import { useCurrentTurnCapabilityScope } from '../../../hooks/useCurrentTurnCapabilityScope';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import {
  getWorkbenchCapabilityBlockedState,
  type WorkbenchCapabilityRegistryItem,
} from '../../../utils/workbenchCapabilityRegistry';
import {
  getWorkbenchCapabilityQuickActionFeedback,
  getWorkbenchCapabilityQuickActions,
  type WorkbenchQuickAction,
} from '../../../utils/workbenchQuickActions';
import {
  formatActionSummary,
  formatScheduleSummary,
  getLatestExecutionStatus,
} from '../cron/types';
import { CronJobEditor } from '../cron/CronJobEditor';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

interface TimeCapabilityPanelProps {
  onClose: () => void;
}

type CalendarActionKey = 'retry' | 'probe' | 'repairPermission' | 'openApp';

interface CalendarCapabilityRow {
  key: 'read' | 'create' | 'update';
  label: string;
  ready: boolean;
  detail: string;
}

interface CalendarState {
  inventory: NativeConnectorInventoryItem | null;
  status: ConnectorStatusSummary | null;
}

const CALENDAR_ACTION_LABELS: Record<CalendarActionKey, string> = {
  retry: '启用/重试',
  probe: '检查',
  repairPermission: '修复权限',
  openApp: '打开 Calendar',
};

function formatDateTime(value?: string | number | null): string {
  if (value == null) return '未返回';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNextRun(job: CronJobDefinition): string {
  if (!job.enabled) return '未启用';
  if (!job.nextRunAt) return '暂无下次运行';
  return formatDateTime(job.nextRunAt);
}

function formatCheckedAt(value?: number): string {
  return value ? formatDateTime(value) : '未检查';
}

function getToneClasses(tone: 'ready' | 'warning' | 'error' | 'neutral'): string {
  switch (tone) {
    case 'ready':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'error':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    default:
      return 'border-zinc-700 bg-zinc-900/70 text-zinc-300';
  }
}

export function getCalendarCapabilityRows(calendar: CalendarState): CalendarCapabilityRow[] {
  const enabled = Boolean(calendar.inventory?.enabled);
  const ready = Boolean(enabled && calendar.status?.connected && calendar.status.readiness === 'ready');
  const capabilities = new Set(calendar.status?.capabilities || []);

  return [
    {
      key: 'read',
      label: '读取事件',
      ready: ready && capabilities.has('list_events'),
      detail: capabilities.has('list_events') ? 'list_events' : '缺少 list_events',
    },
    {
      key: 'create',
      label: '创建事件',
      ready: ready && capabilities.has('create_event'),
      detail: capabilities.has('create_event') ? 'create_event' : '缺少 create_event',
    },
    {
      key: 'update',
      label: '更新事件',
      ready: ready && capabilities.has('update_event'),
      detail: capabilities.has('update_event') ? 'update_event' : '缺少 update_event',
    },
  ];
}

export function getCalendarRepairActions(calendar: CalendarState): CalendarActionKey[] {
  if (!calendar.inventory?.enabled || !calendar.status) {
    return ['retry', 'openApp'];
  }

  if (calendar.status.readiness === 'ready' && calendar.status.connected) {
    return ['probe'];
  }

  if (calendar.status.readiness === 'failed') {
    return ['repairPermission', 'openApp', 'probe'];
  }

  return ['probe', 'repairPermission', 'openApp'];
}

function getCalendarStatusLabel(calendar: CalendarState): { label: string; tone: 'ready' | 'warning' | 'error' | 'neutral' } {
  if (!calendar.inventory) {
    return { label: '未发现 Calendar connector', tone: 'warning' };
  }
  if (!calendar.inventory.enabled) {
    return { label: '未启用', tone: 'warning' };
  }
  if (!calendar.status) {
    return { label: '状态未返回', tone: 'warning' };
  }
  if (calendar.status.readiness === 'ready' && calendar.status.connected) {
    return { label: '可用', tone: 'ready' };
  }
  if (calendar.status.readiness === 'failed') {
    return { label: '权限异常', tone: 'error' };
  }
  if (calendar.status.readiness === 'unavailable') {
    return { label: '当前环境不可用', tone: 'warning' };
  }
  return { label: '待检查', tone: 'warning' };
}

function getCapabilityIssueLabel(capability: WorkbenchCapabilityRegistryItem): string {
  if (capability.kind === 'skill') {
    if (capability.lifecycle.installState === 'missing') return 'Skill 未安装';
    if (capability.lifecycle.mountState === 'unmounted') return 'Skill 未启用';
    if (!capability.selected) return '不在本轮 toolScope';
    return 'Skill 需处理';
  }

  if (capability.kind === 'mcp') {
    if (capability.lifecycle.connectionState === 'error') return 'MCP server 异常';
    if (capability.lifecycle.connectionState === 'disconnected') return 'MCP server 停止';
    if (!capability.selected) return '不在本轮 toolScope';
    return 'MCP 需处理';
  }

  if (capability.lifecycle.connectionState === 'error' || capability.lifecycle.connectionState === 'lazy') {
    return 'Native permission 缺失';
  }
  if (capability.lifecycle.connectionState === 'disconnected') {
    return 'Connector 未连接';
  }
  if (!capability.selected) {
    return '不在本轮 toolScope';
  }
  return 'Connector 需处理';
}

function capabilitySeverity(capability: WorkbenchCapabilityRegistryItem): 'ready' | 'warning' | 'error' | 'neutral' {
  if (capability.health === 'healthy') return 'ready';
  if (capability.health === 'error') return 'error';
  if (capability.blocked || capability.health === 'degraded') return 'warning';
  return 'neutral';
}

function getCapabilityDetail(capability: WorkbenchCapabilityRegistryItem): string {
  if (capability.kind !== 'skill' && capability.error) {
    return capability.error;
  }
  return capability.label;
}

function dedupeCapabilities(items: WorkbenchCapabilityRegistryItem[]): WorkbenchCapabilityRegistryItem[] {
  const seen = new Set<string>();
  const result: WorkbenchCapabilityRegistryItem[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    result.push(item);
  }
  return result;
}

function buildCapabilityFixItems(args: {
  registryItems: WorkbenchCapabilityRegistryItem[];
  currentTurnBlocked: WorkbenchCapabilityRegistryItem[];
}): WorkbenchCapabilityRegistryItem[] {
  const selectedBlocked = args.registryItems.filter((item) => item.selected && (item.blocked || getWorkbenchCapabilityBlockedState(item)));
  const knownRuntimeIssues = args.registryItems.filter((item) => {
    if (item.selected) return false;
    if (item.kind === 'skill') return false;
    return item.health === 'error' || item.health === 'degraded' || item.lifecycle.connectionState === 'disconnected';
  });

  return dedupeCapabilities([
    ...args.currentTurnBlocked,
    ...selectedBlocked,
    ...knownRuntimeIssues,
  ]).slice(0, 8);
}

const TimeCapabilityPanel: React.FC<TimeCapabilityPanelProps> = ({ onClose }) => {
  const {
    jobs,
    stats,
    latestExecutions,
    isEditorOpen,
    editingJobId,
    isLoading,
    error,
    refresh,
    triggerJob,
    openCreateEditor,
    closeEditor,
  } = useCronStore();
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const capabilityRegistry = useWorkbenchCapabilityRegistry();
  const currentTurnScope = useCurrentTurnCapabilityScope();
  const {
    runningActionKey,
    actionErrors,
    completedActions,
    runQuickAction,
  } = useWorkbenchCapabilityQuickActionRunner();

  const [triggeringJobId, setTriggeringJobId] = useState<string | null>(null);
  const [calendarInventory, setCalendarInventory] = useState<NativeConnectorInventoryItem[]>([]);
  const [calendarStatuses, setCalendarStatuses] = useState<ConnectorStatusSummary[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarBusyAction, setCalendarBusyAction] = useState<CalendarActionKey | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCalendar = useCallback(async () => {
    setCalendarLoading(true);
    setCalendarError(null);
    try {
      const [inventory, statuses] = await Promise.all([
        ipcService.invokeDomain<NativeConnectorInventoryItem[]>(
          IPC_DOMAINS.CONNECTOR,
          'listNativeInventory',
        ),
        ipcService.invokeDomain<ConnectorStatusSummary[]>(
          IPC_DOMAINS.CONNECTOR,
          'listStatuses',
        ),
      ]);
      setCalendarInventory(Array.isArray(inventory) ? inventory : []);
      setCalendarStatuses(Array.isArray(statuses) ? statuses : []);
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : String(err));
      setCalendarInventory([]);
      setCalendarStatuses([]);
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCalendar();
  }, [refreshCalendar]);

  const activeJobs = useMemo(
    () => jobs.filter((job) => job.enabled),
    [jobs],
  );
  const failedJobs = useMemo(
    () => jobs.filter((job) => latestExecutions[job.id]?.status === 'failed'),
    [jobs, latestExecutions],
  );
  const upcomingJobs = useMemo(
    () => [...activeJobs]
      .sort((left, right) => (left.nextRunAt ?? Number.POSITIVE_INFINITY) - (right.nextRunAt ?? Number.POSITIVE_INFINITY))
      .slice(0, 6),
    [activeJobs],
  );
  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) || null,
    [editingJobId, jobs],
  );

  const calendarState = useMemo<CalendarState>(() => ({
    inventory: calendarInventory.find((item) => item.id === 'calendar') || null,
    status: calendarStatuses.find((status) => status.id === 'calendar') || null,
  }), [calendarInventory, calendarStatuses]);
  const calendarStatus = getCalendarStatusLabel(calendarState);
  const calendarCapabilityRows = getCalendarCapabilityRows(calendarState);
  const calendarRepairActions = getCalendarRepairActions(calendarState);

  const fixItems = useMemo(
    () => buildCapabilityFixItems({
      registryItems: capabilityRegistry.items,
      currentTurnBlocked: currentTurnScope?.blockedCapabilities || [],
    }),
    [capabilityRegistry.items, currentTurnScope],
  );
  const selectedCapabilityCount = capabilityRegistry.items.filter((item) => item.selected).length;
  const scopeSummary = currentTurnScope
    ? `已选 ${currentTurnScope.scope.selected.length} · 放行 ${currentTurnScope.scope.allowed.length} · 阻塞 ${currentTurnScope.scope.blocked.length} · 调用 ${currentTurnScope.scope.invoked.length}`
    : selectedCapabilityCount > 0
      ? `待发送能力 ${selectedCapabilityCount}`
      : '本轮 toolScope 未包含显式能力';

  const handleTriggerJob = useCallback(async (jobId: string) => {
    setTriggeringJobId(jobId);
    try {
      await triggerJob(jobId);
    } finally {
      setTriggeringJobId(null);
    }
  }, [triggerJob]);

  const handleCalendarAction = useCallback(async (action: CalendarActionKey) => {
    setCalendarBusyAction(action);
    setCalendarError(null);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.CONNECTOR, action, { connectorId: 'calendar' });
      await refreshCalendar();
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalendarBusyAction(null);
    }
  }, [refreshCalendar]);

  const renderCronJobRow = (job: CronJobDefinition, options?: { showError?: boolean }) => {
    const latest = latestExecutions[job.id];
    const latestMeta = getLatestExecutionStatus(latest);
    const isTriggering = triggeringJobId === job.id;
    return (
      <div key={job.id} className="grid gap-3 border-t border-zinc-800 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_150px_120px_auto] md:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-100">{job.name}</div>
          <div className="mt-1 truncate text-xs text-zinc-500">{formatScheduleSummary(job)} · {formatActionSummary(job)}</div>
          {options?.showError && latest?.error && (
            <div className="mt-1 line-clamp-2 text-xs text-red-300">{latest.error}</div>
          )}
        </div>
        <div className="text-xs text-zinc-400">
          <span className="text-zinc-500">下次</span>
          <div className="mt-1 text-zinc-200">{formatNextRun(job)}</div>
        </div>
        <div>
          <span className={`inline-flex rounded-md px-2 py-1 text-[11px] ${latestMeta.className}`}>
            {latestMeta.label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleTriggerJob(job.id)}
          disabled={isTriggering}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-blue-500/30 px-2.5 py-1.5 text-xs text-blue-300 transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isTriggering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          手动触发
        </button>
      </div>
    );
  };

  return (
    <FullScreenPage testId="time-capability-panel">
      <FullScreenPageHeader
        icon={<CalendarDays className="h-4 w-4 text-sky-300" />}
        title="Time & Capability"
        description="任务时间、Cron 运行、Calendar 状态和现场修复"
        onClose={onClose}
        closeLabel="关闭 Time & Capability"
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto grid max-w-7xl gap-4 xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
          <section className="min-w-0 border border-zinc-800 bg-zinc-900/40">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-amber-300" />
                <h3 className="text-sm font-semibold text-zinc-100">Time Workbench</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  刷新
                </button>
                <button
                  type="button"
                  onClick={openCreateEditor}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  <TimerReset className="h-3.5 w-3.5" />
                  新建
                </button>
              </div>
            </div>

            <div className="grid divide-y divide-zinc-800 md:grid-cols-4 md:divide-x md:divide-y-0">
              <Metric label="活跃任务" value={String(stats?.activeJobs ?? activeJobs.length)} />
              <Metric label="全部任务" value={String(stats?.totalJobs ?? jobs.length)} />
              <Metric label="失败任务" value={String(failedJobs.length)} tone={failedJobs.length > 0 ? 'error' : 'neutral'} />
              <Metric label="成功率" value={`${(stats?.successRate ?? 0).toFixed(0)}%`} />
            </div>

            {error && (
              <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="border-t border-zinc-800">
              <div className="flex items-center justify-between px-4 py-2">
                <div className="text-xs font-medium text-zinc-300">下一批运行</div>
                <div className="text-[11px] text-zinc-500">{activeJobs.length} 个启用</div>
              </div>
              {isLoading && jobs.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-8 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在加载定时任务
                </div>
              ) : upcomingJobs.length === 0 ? (
                <div className="border-t border-zinc-800 px-4 py-8 text-sm text-zinc-500">
                  当前没有启用的 Cron 任务。
                </div>
              ) : (
                <div>{upcomingJobs.map((job) => renderCronJobRow(job))}</div>
              )}
            </div>

            <div className="border-t border-zinc-800">
              <div className="px-4 py-2 text-xs font-medium text-zinc-300">失败任务</div>
              {failedJobs.length === 0 ? (
                <div className="border-t border-zinc-800 px-4 py-4 text-sm text-zinc-500">
                  最近执行没有失败任务。
                </div>
              ) : (
                <div>{failedJobs.map((job) => renderCronJobRow(job, { showError: true }))}</div>
              )}
            </div>

            <div className="border-t border-zinc-800 px-4 py-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-sky-300" />
                  <div className="text-sm font-medium text-zinc-100">Calendar connector</div>
                </div>
                <span className={`rounded-md border px-2 py-1 text-[11px] ${getToneClasses(calendarStatus.tone)}`}>
                  {calendarStatus.label}
                </span>
              </div>

              {calendarLoading ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取 Calendar 状态
                </div>
              ) : (
                <>
                  <div className="grid gap-2 md:grid-cols-4">
                    <CapabilityStatusCell
                      label="Connector"
                      ready={Boolean(calendarState.inventory?.enabled && calendarState.status)}
                      detail={calendarState.inventory?.enabled ? '已启用' : '未启用'}
                    />
                    <CapabilityStatusCell
                      label="权限"
                      ready={calendarState.status?.readiness === 'ready'}
                      detail={calendarState.status?.detail || calendarState.status?.error || formatCheckedAt(calendarState.status?.checkedAt)}
                    />
                    {calendarCapabilityRows.map((row) => (
                      <CapabilityStatusCell
                        key={row.key}
                        label={row.label}
                        ready={row.ready}
                        detail={row.detail}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {calendarRepairActions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => void handleCalendarAction(action)}
                        disabled={Boolean(calendarBusyAction)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {calendarBusyAction === action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                        {CALENDAR_ACTION_LABELS[action]}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {calendarError && (
                <div className="mt-3 text-xs text-red-300">{calendarError}</div>
              )}
            </div>
          </section>

          <section className="min-w-0 border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Wrench className="h-4 w-4 text-amber-300" />
                <h3 className="text-sm font-semibold text-zinc-100">Capability Fix</h3>
              </div>
              <span className={`rounded-md border px-2 py-1 text-[11px] ${getToneClasses(fixItems.length > 0 ? 'warning' : 'ready')}`}>
                {fixItems.length > 0 ? `${fixItems.length} 项需处理` : '当前可用'}
              </span>
            </div>

            <div className="border-b border-zinc-800 px-4 py-3">
              <div className="text-xs text-zinc-500">本轮 toolScope</div>
              <div className="mt-1 text-sm text-zinc-200">{scopeSummary}</div>
              {selectedCapabilityCount === 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => openSettingsTab('skills')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    <Settings className="h-3 w-3" />
                    Skills
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettingsTab('mcp')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    <Settings className="h-3 w-3" />
                    MCP / Connectors
                  </button>
                </div>
              )}
            </div>

            {fixItems.length === 0 ? (
              <div className="px-4 py-8 text-sm text-zinc-500">
                当前任务没有被 registry 标记为阻塞的 skill、MCP 或 connector。
              </div>
            ) : (
              <div>
                {fixItems.map((capability) => {
                  const blockedReason = getWorkbenchCapabilityBlockedState(capability);
                  const actions = getWorkbenchCapabilityQuickActions(capability, {
                    includeUnselected: !capability.selected,
                  });
                  const error = actionErrors[capability.key] || null;
                  const feedback = getWorkbenchCapabilityQuickActionFeedback(
                    capability,
                    completedActions[capability.key],
                  );
                  return (
                    <CapabilityFixRow
                      key={capability.key}
                      capability={capability}
                      issueLabel={getCapabilityIssueLabel(capability)}
                      tone={capabilitySeverity(capability)}
                      detail={blockedReason?.detail || getCapabilityDetail(capability)}
                      hint={blockedReason?.hint}
                      actions={actions}
                      runningActionKey={runningActionKey}
                      error={error}
                      feedback={feedback?.message}
                      feedbackTone={feedback?.tone}
                      onQuickAction={runQuickAction}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <CronJobEditor
        isOpen={isEditorOpen}
        job={editingJob}
        onClose={closeEditor}
      />
    </FullScreenPage>
  );
};

const Metric: React.FC<{ label: string; value: string; tone?: 'error' | 'neutral' }> = ({ label, value, tone = 'neutral' }) => (
  <div className="px-4 py-3">
    <div className="text-[11px] text-zinc-500">{label}</div>
    <div className={`mt-1 text-xl font-semibold ${tone === 'error' ? 'text-red-300' : 'text-zinc-100'}`}>{value}</div>
  </div>
);

const CapabilityStatusCell: React.FC<{ label: string; ready: boolean; detail: string }> = ({ label, ready, detail }) => (
  <div className="border border-zinc-800 bg-zinc-950/40 px-3 py-2">
    <div className="flex items-center gap-1.5 text-xs text-zinc-300">
      {ready ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <ShieldAlert className="h-3.5 w-3.5 text-amber-300" />}
      {label}
    </div>
    <div className="mt-1 truncate text-[11px] text-zinc-500" title={detail}>{detail}</div>
  </div>
);

const CapabilityFixRow: React.FC<{
  capability: WorkbenchCapabilityRegistryItem;
  issueLabel: string;
  tone: 'ready' | 'warning' | 'error' | 'neutral';
  detail: string;
  hint?: string;
  actions: WorkbenchQuickAction[];
  runningActionKey: string | null;
  error: string | null;
  feedback?: string;
  feedbackTone?: 'success' | 'info';
  onQuickAction: (capability: WorkbenchCapabilityRegistryItem, action: WorkbenchQuickAction) => Promise<void>;
}> = ({
  capability,
  issueLabel,
  tone,
  detail,
  hint,
  actions,
  runningActionKey,
  error,
  feedback,
  feedbackTone,
  onQuickAction,
}) => (
  <div className="border-t border-zinc-800 px-4 py-3">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{capability.label}</span>
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${getToneClasses(tone)}`}>
            {issueLabel}
          </span>
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-zinc-400">{detail}</div>
        {hint && <div className="mt-1 line-clamp-2 text-[11px] text-zinc-500">{hint}</div>}
      </div>
      {tone === 'error' ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
      ) : (
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      )}
    </div>

    {actions.length > 0 ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => {
          const actionKey = `${capability.key}:${action.kind}`;
          const loading = runningActionKey === actionKey;
          return (
            <button
              key={actionKey}
              type="button"
              onClick={() => void onQuickAction(capability, action)}
              disabled={loading}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                action.emphasis === 'primary'
                  ? 'border-blue-500/30 text-blue-300 hover:bg-blue-500/10'
                  : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              {action.label}
            </button>
          );
        })}
      </div>
    ) : (
      <div className="mt-2 text-[11px] text-zinc-500">没有可直接执行的修复动作。</div>
    )}

    {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
    {!error && feedback && (
      <div className={`mt-2 text-[11px] ${feedbackTone === 'success' ? 'text-emerald-300' : 'text-sky-300'}`}>
        {feedback}
      </div>
    )}
  </div>
);

export default TimeCapabilityPanel;
