// ============================================================================
// AutomationSettings - 自动化（定时任务）设置 tab
// ============================================================================
//
// P1 IA：把 CronCenterPanel 的核心交互（任务列表 + 编辑器）搬进 Settings 的
// 「工作区与自动化」组。复用 useCronStore 和 CronJobEditor，不重写。
// CronJobEditor 自带自然语言向导（generateFromPrompt）和模板，所以这里不需要
// 重新实现 prompt 流程，只暴露「新建」入口即可。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleDot,
  Filter,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import { Button } from '../../../primitives';
import {
  useCronStore,
  type CronJobFilterMode,
} from '../../../../stores/cronStore';
import { CronJobEditor } from '../../cron/CronJobEditor';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { WebModeBanner } from '../WebModeBanner';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

type AutomationSettingsText = typeof zh.settings.automation;

const FILTER_VALUES: CronJobFilterMode[] = ['all', 'enabled', 'disabled'];

function describeSchedule(
  job: CronJobDefinition,
  labels: AutomationSettingsText['schedule'] = zh.settings.automation.schedule,
): string {
  const schedule = job.schedule;
  if (!schedule) return '—';
  if (schedule.type === 'every') {
    const unit = labels.units[schedule.unit as keyof typeof labels.units] ?? schedule.unit;
    return `${labels.everyPrefix}${schedule.interval}${labels.everyMiddle}${unit}`;
  }
  if (schedule.type === 'cron') {
    return `cron: ${schedule.expression}${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
  }
  if (schedule.type === 'at') {
    const datetime = typeof schedule.datetime === 'number'
      ? new Date(schedule.datetime).toLocaleString()
      : schedule.datetime;
    return `${labels.atPrefix}${datetime}`;
  }
  return '—';
}

function describeAction(job: CronJobDefinition): string {
  const action = job.action;
  if (!action) return '—';
  if (action.type === 'shell') return `shell: ${action.command}`;
  if (action.type === 'webhook') return `webhook: ${action.method} ${action.url}`;
  if (action.type === 'tool') return `tool: ${action.toolName}`;
  if (action.type === 'agent') return `agent: ${action.agentType}`;
  if (action.type === 'ipc') return `ipc: ${action.channel}`;
  return '—';
}

function formatTimestamp(ts?: number | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

function statusLabel(
  execution: CronJobExecution | null | undefined,
  labels: AutomationSettingsText['executionStatus'] = zh.settings.automation.executionStatus,
): string {
  if (!execution) return labels.notRun;
  if (execution.status === 'completed') return labels.completed;
  if (execution.status === 'failed') return labels.failed;
  if (execution.status === 'running') return labels.running;
  if (execution.status === 'pending') return labels.pending;
  if (execution.status === 'cancelled') return labels.cancelled;
  if (execution.status === 'paused') return labels.paused;
  return execution.status;
}

function statusClass(execution: CronJobExecution | null | undefined): string {
  if (!execution) return 'border-zinc-700 bg-zinc-800 text-zinc-400';
  if (execution.status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (execution.status === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (execution.status === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-300';
  return 'border-zinc-700 bg-zinc-800 text-zinc-400';
}

export const AutomationSettings: React.FC = () => {
  const { t } = useI18n();
  const automationText = t.settings.automation;
  const {
    jobs,
    stats,
    latestExecutions,
    filterMode,
    isLoading,
    isEditorOpen,
    editingJobId,
    setFilterMode,
    refresh,
    openCreateEditor,
    openEditEditor,
    closeEditor,
    updateJob,
    deleteJob,
    triggerJob,
  } = useCronStore();

  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const filterOptions = useMemo(
    () => FILTER_VALUES.map((value) => ({ value, label: automationText.filters[value] })),
    [automationText],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reload when filter changes
  useEffect(() => {
    void refresh();
  }, [filterMode, refresh]);

  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) || null,
    [jobs, editingJobId],
  );
  const detailJob = useMemo(
    () => jobs.find((job) => job.id === detailJobId) || null,
    [jobs, detailJobId],
  );

  const handleToggleEnabled = useCallback(async (job: CronJobDefinition) => {
    setBusyJobId(job.id);
    try {
      await updateJob(job.id, { enabled: !job.enabled });
    } finally {
      setBusyJobId(null);
    }
  }, [updateJob]);

  const handleTrigger = useCallback(async (job: CronJobDefinition) => {
    setBusyJobId(job.id);
    try {
      await triggerJob(job.id);
    } finally {
      setBusyJobId(null);
    }
  }, [triggerJob]);

  const handleDelete = useCallback(async (job: CronJobDefinition) => {
    if (!window.confirm(`${automationText.deleteConfirmPrefix}${job.name}${automationText.deleteConfirmSuffix}`)) return;
    setBusyJobId(job.id);
    try {
      await deleteJob(job.id);
      if (detailJobId === job.id) setDetailJobId(null);
    } finally {
      setBusyJobId(null);
    }
  }, [automationText, deleteJob, detailJobId]);

  return (
    <SettingsPage
      title={t.settings.tabs.automation}
      description={automationText.description}
    >
      <WebModeBanner />

      <SettingsSection
        title={automationText.overview.title}
        description={automationText.overview.description}
        actions={(
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refresh()}
              disabled={isLoading}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              {automationText.actions.refresh}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={isWebMode()}
              onClick={openCreateEditor}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              {automationText.actions.createJob}
            </Button>
          </div>
        )}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              [automationText.stats.totalJobs, String(stats?.totalJobs ?? jobs.length), `${stats?.activeJobs ?? 0}${automationText.stats.activeJobsSuffix}`],
              [automationText.stats.totalExecutions, String(stats?.totalExecutions ?? 0), `${stats?.successfulExecutions ?? 0}${automationText.stats.successfulExecutionsSuffix}`],
              [automationText.stats.failedExecutions, String(stats?.failedExecutions ?? 0), automationText.stats.needsAttention],
              [automationText.stats.successRate, `${(stats?.successRate ?? 0).toFixed(0)}%`, automationText.stats.recentStats],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
            <Filter className="h-3.5 w-3.5 text-zinc-500" />
            <span>{automationText.filterLabel}</span>
            {filterOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFilterMode(opt.value)}
                className={`rounded border px-2 py-1 transition-colors ${
                  filterMode === opt.value
                    ? 'border-zinc-500 bg-zinc-800/70 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{automationText.table.name}</th>
                  <th className="px-3 py-2 font-medium">{automationText.table.status}</th>
                  <th className="px-3 py-2 font-medium">{automationText.table.frequency}</th>
                  <th className="px-3 py-2 font-medium">{automationText.table.nextRun}</th>
                  <th className="px-3 py-2 font-medium">{automationText.table.latestRun}</th>
                  <th className="px-3 py-2 text-right font-medium">{automationText.table.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading && jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">{automationText.loading}</td>
                  </tr>
                ) : jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                      <div className="flex flex-col items-center gap-1">
                        <Sparkles className="h-5 w-5 text-zinc-600" />
                        <div>{automationText.empty}</div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => {
                    const latest = latestExecutions[job.id];
                    const busy = busyJobId === job.id;
                    return (
                      <tr key={job.id} className="bg-zinc-900/40 hover:bg-zinc-800/60">
                        <td className="px-3 py-3 align-middle">
                          <button
                            type="button"
                            onClick={() => setDetailJobId(job.id)}
                            className="flex w-full min-w-0 items-start gap-2 text-left"
                          >
                            <span className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300">
                              <CircleDot className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-zinc-200">{job.name}</div>
                              {job.description && (
                                <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={job.description}>
                                  {job.description}
                                </div>
                              )}
                            </div>
                          </button>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span
                            className={`inline-flex rounded border px-2 py-1 ${
                              job.enabled
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {job.enabled ? automationText.actions.enable : automationText.jobStatus.disabled}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-300" title={describeAction(job)}>
                          {describeSchedule(job, automationText.schedule)}
                        </td>
                        <td className="px-3 py-3 align-middle text-zinc-400">{formatTimestamp(job.nextRunAt)}</td>
                        <td className="px-3 py-3 align-middle">
                          <span className={`inline-flex rounded border px-2 py-1 ${statusClass(latest)}`}>
                            {statusLabel(latest, automationText.executionStatus)}
                          </span>
                          {latest?.startedAt && (
                            <div className="mt-1 text-[11px] text-zinc-500">{formatTimestamp(latest.startedAt)}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || isWebMode()}
                              onClick={() => void handleTrigger(job)}
                              leftIcon={<Play className="h-3.5 w-3.5" />}
                            >
                              {automationText.actions.run}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || isWebMode()}
                              onClick={() => void handleToggleEnabled(job)}
                              leftIcon={job.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                            >
                              {job.enabled ? automationText.actions.pause : automationText.actions.enable}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || isWebMode()}
                              onClick={() => openEditEditor(job.id)}
                            >
                              {automationText.actions.edit}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      {/* 编辑器（复用 cron/CronJobEditor，含自然语言向导/模板） */}
      <CronJobEditor isOpen={isEditorOpen} job={editingJob} onClose={closeEditor} />

      {detailJob && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={() => setDetailJobId(null)}
        >
          <aside
            className="h-full w-[420px] overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-100">{detailJob.name}</div>
                {detailJob.description && (
                  <div className="mt-1 text-[11px] text-zinc-500">{detailJob.description}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDetailJobId(null)}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label={automationText.actions.closeDetails}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-zinc-300">
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{automationText.table.frequency}</div>
                <div className="mt-1">{describeSchedule(detailJob, automationText.schedule)}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{automationText.details.action}</div>
                <div className="mt-1 break-all">{describeAction(detailJob)}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{automationText.table.nextRun}</div>
                <div className="mt-1">{formatTimestamp(detailJob.nextRunAt)}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{automationText.details.latestExecution}</div>
                <div className="mt-1">
                  <span className={`inline-flex rounded border px-2 py-1 ${statusClass(latestExecutions[detailJob.id])}`}>
                    {statusLabel(latestExecutions[detailJob.id], automationText.executionStatus)}
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500">
                  {automationText.details.startedAtPrefix}{formatTimestamp(latestExecutions[detailJob.id]?.startedAt)}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {automationText.details.completedAtPrefix}{formatTimestamp(latestExecutions[detailJob.id]?.completedAt)}
                </div>
                {latestExecutions[detailJob.id]?.error && (
                  <div className="mt-1 break-all text-[11px] text-red-300">
                    {automationText.details.errorPrefix}{latestExecutions[detailJob.id]?.error}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isWebMode()}
                  onClick={() => openEditEditor(detailJob.id)}
                >
                  {automationText.actions.edit}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isWebMode()}
                  onClick={() => void handleDelete(detailJob)}
                >
                  {automationText.actions.delete}
                </Button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </SettingsPage>
  );
};
