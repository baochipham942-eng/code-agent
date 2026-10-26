// 角色详情里的绑定自动化：上次结果、暂停/恢复、现在运行。
// 编辑和删除仍留在自动化面板。主动性巡检（role-wake）不提供暂停，避免和上方主动性表单打架。

import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { formatCronExpressionLabel, type CronHumanLang } from '@shared/cronHumanize';
import type { RoleBoundCronJob } from '@shared/contract/roleAssets';
import type { CronScheduleConfig } from '@shared/contract/cron';
import ipcService from '../../../services/ipcService';
import { cronClient } from '../../../services/cronClient';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { Button } from '../../primitives/Button';
import { SettingsSection } from '../settings/SettingsLayout';

type RoleDetailText = ReturnType<typeof useI18n>['t']['expert']['roleDetail'];
type CronStatusText = ReturnType<typeof useI18n>['t']['cronCenter']['status'];

const EMPTY_JOBS: RoleBoundCronJob[] = [];

function formatAutomationSchedule(schedule: CronScheduleConfig, text: RoleDetailText, lang: CronHumanLang): string {
  if (schedule.type === 'every') {
    return text.automationEvery.replace('{interval}', String(schedule.interval)).replace('{unit}', text.automationUnits[schedule.unit]);
  }
  if (schedule.type === 'at') {
    const timestamp = typeof schedule.datetime === 'number' ? schedule.datetime : Date.parse(schedule.datetime);
    const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(schedule.datetime);
    return text.automationAt.replace('{time}', time);
  }
  if (schedule.type === 'event') {
    // connector 源（mail）没有 chatId，绑定信息是账号 + 邮箱。
    const binding = schedule.source === 'connector'
      ? `${schedule.accountId}${schedule.mailbox ? ` · ${schedule.mailbox}` : ''}`
      : `${schedule.accountId}${schedule.chatId ? ` · ${schedule.chatId}` : ''}`;
    return `事件触发 · ${binding}`;
  }
  return formatCronExpressionLabel(schedule.expression, schedule.timezone, lang);
}

function statusLabel(status: RoleBoundCronJob['lastStatus'], words: CronStatusText): string {
  if (!status) return words.none;
  return words[status] ?? words.none;
}

function lastRunLine(job: RoleBoundCronJob, text: RoleDetailText, words: CronStatusText): string {
  if (job.lastRunAt === undefined) return text.automationLastNever;
  const time = new Date(job.lastRunAt).toLocaleString();
  const status = statusLabel(job.lastStatus, words);
  if (job.lastStatus === 'failed' && job.lastError) {
    return text.automationLastFailed.replace('{time}', time).replace('{status}', status).replace('{reason}', job.lastError);
  }
  return text.automationLastRun.replace('{time}', time).replace('{status}', status);
}

function inlineActionError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0 && !/^at\s+\S/.test(part));
  if (!line || line.length > 160) return fallback;
  return line;
}

export interface RoleRoutinesSectionProps {
  roleId: string;
  jobs?: RoleBoundCronJob[];
  onJobsChange?: (jobs: RoleBoundCronJob[]) => void;
}

export const RoleRoutinesSection: React.FC<RoleRoutinesSectionProps> = ({
  roleId,
  jobs = EMPTY_JOBS,
  onJobsChange,
}) => {
  const { t, language } = useI18n();
  const text = t.expert.roleDetail;
  const statusWords = t.cronCenter.status;
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const [rows, setRows] = useState(jobs);
  const [busy, setBusy] = useState<{ id: string; action: 'toggle' | 'run' } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    setRows(jobs);
  }, [jobs]);

  async function reload(): Promise<RoleBoundCronJob[] | null> {
    const next = await ipcService.invokeDomain<RoleBoundCronJob[]>(IPC_DOMAINS.ROLES, 'listBoundCronJobs', { roleId });
    return Array.isArray(next) ? next : null;
  }

  async function runRowAction(job: RoleBoundCronJob, action: 'toggle' | 'run', work: () => Promise<unknown>) {
    setBusy({ id: job.id, action });
    setRowError((current) => (current?.id === job.id ? null : current));
    try {
      await work();
      const next = await reload();
      if (next) {
        setRows(next);
        onJobsChange?.(next);
      }
    } catch (error) {
      setRowError({ id: job.id, message: inlineActionError(error, text.automationActionFailed) });
    } finally {
      setBusy((current) => (current?.id === job.id && current.action === action ? null : current));
    }
  }

  return (
    <SettingsSection title={text.automationsTitle} description={text.automationsDescription}>
      {rows.length === 0 ? (
        <div data-testid="role-bound-automations-empty" className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">{text.automationsEmpty}</div>
      ) : (
        <div className="space-y-2" data-testid="role-bound-automations-list">
          {rows.map((job) => {
            const nextRun = job.nextRunAt ? text.automationNextRun.replace('{time}', new Date(job.nextRunAt).toLocaleString()) : text.automationNoNextRun;
            const toggling = busy?.id === job.id && busy.action === 'toggle';
            const running = busy?.id === job.id && busy.action === 'run';
            const failed = job.lastStatus === 'failed';
            return (
              <div key={job.id} data-testid={`role-bound-automation-${job.id}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-zinc-200">{job.name}</div>
                    <div className="mt-1 text-xs text-zinc-500">{formatAutomationSchedule(job.schedule, text, language)} · {nextRun}</div>
                    <div data-testid={`role-bound-automation-last-${job.id}`} className={`mt-1 text-xs ${failed ? 'text-badge-danger' : 'text-zinc-500'}`}>{lastRunLine(job, text, statusWords)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`rounded px-1.5 py-0.5 ${job.enabled ? 'bg-emerald-500/10 text-badge-success' : 'bg-zinc-700/60 text-zinc-400'}`}>{job.enabled ? text.automationStatusEnabled : text.automationStatusDisabled}</span>
                    <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-badge-accent">{job.actionType === 'agent' ? text.automationTypeAgent : text.automationTypeRoleWake}</span>
                  </div>
                </div>
                {job.actionType === 'role_wake' ? <p data-testid={`role-bound-automation-managed-${job.id}`} className="mt-2 text-xs text-badge-warning/80">{text.automationRoleWakeManaged}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {job.actionType === 'agent' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`role-bound-automation-toggle-${job.id}`}
                      loading={toggling}
                      disabled={toggling || running}
                      onClick={() => void runRowAction(job, 'toggle', () => cronClient.updateJob(job.id, { enabled: !job.enabled }))}
                    >
                      {job.enabled ? text.automationPause : text.automationResume}
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid={`role-bound-automation-run-${job.id}`}
                    loading={running}
                    disabled={running || toggling}
                    onClick={() => void runRowAction(job, 'run', () => cronClient.triggerJob(job.id))}
                  >
                    {running ? text.automationRunning : text.automationRunNow}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowCronCenter(true)}>{text.automationOpenPanel}</Button>
                </div>
                {rowError?.id === job.id ? <p role="alert" data-testid={`role-bound-automation-error-${job.id}`} className="mt-1 text-xs text-badge-danger">{rowError.message}</p> : null}
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
};
