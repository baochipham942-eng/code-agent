// ============================================================================
// RoleWakeLedger —— 角色页「最近唤醒」+ 每日成本（N-CRON-RUN-LEDGER-VISIBLE）。
// 只聚合该角色 role-wake 任务的执行记录，走既有 cron IPC（listJobs + getExecutions，
// 不加新通道）；event 触发的唤醒不产生执行记录，天然不在内。
// RoleDetailPage 贴 max-lines 线：本组件自包含 section 外壳，页面只加一行 JSX。
// ============================================================================
import React, { useEffect, useState } from 'react';
import type { CronJobExecution } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import { cronClient } from '../../../services/cronClient';
import { SettingsSection } from '../settings/SettingsLayout';
import { CronDailyCostSummary } from '../cron/CronDailyCostSummary';
import { wakeSkipSentence } from '../cron/wakeSkipSentence';
import { formatDateTime, formatRunCostUsd } from '../cron/types';

const WAKE_HISTORY_PER_JOB = 20;

async function loadRoleWakeExecutions(roleId: string): Promise<CronJobExecution[]> {
  const jobs = await cronClient.listJobs();
  const wakeJobIds = jobs
    .filter((job) => job.action.type === 'role-wake' && job.action.roleId === roleId)
    .map((job) => job.id);
  const lists = await Promise.all(wakeJobIds.map((jobId) => cronClient.getExecutions(jobId, WAKE_HISTORY_PER_JOB)));
  return lists.flat().sort((a, b) => (b.startedAt ?? b.scheduledAt) - (a.startedAt ?? a.scheduledAt));
}

export const RoleWakeLedger: React.FC<{ roleId: string }> = ({ roleId }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const [executions, setExecutions] = useState<CronJobExecution[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setExecutions(null);
    void loadRoleWakeExecutions(roleId)
      .then((list) => { if (!cancelled) setExecutions(list); })
      .catch(() => { if (!cancelled) setExecutions([]); });
    return () => { cancelled = true; };
  }, [roleId]);
  if (executions === null) return null;
  return (
    <SettingsSection title={cc.roleWakeRecentTitle} description={cc.roleWakeRecentDescription}>
      <CronDailyCostSummary executions={executions} testId="role-wake-daily-cost" />
      {executions.length === 0 ? (
        <div
          data-testid="role-wake-ledger-empty"
          className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500"
        >
          {cc.roleWakeRecentEmpty}
        </div>
      ) : (
        <ul
          className="mt-2 space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3"
          data-testid="role-wake-ledger-list"
        >
          {executions.map((execution) => {
            const skipText = wakeSkipSentence(execution, {
              silentLevel: cc.wakeSkipSilentLevel,
              dailyBudget: cc.wakeSkipDailyBudget,
              quietHours: cc.wakeSkipQuietHours,
            });
            return (
              <li
                key={execution.id}
                data-testid="role-wake-ledger-row"
                className="flex items-center justify-between gap-3 text-xs text-zinc-400"
              >
                <span>{formatDateTime(execution.startedAt ?? execution.scheduledAt)}</span>
                <span className="min-w-0 truncate text-right" data-testid="role-wake-ledger-value">
                  {skipText ?? (execution.cost != null ? formatRunCostUsd(execution.cost) : cc.roleWakeNoModel)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};
