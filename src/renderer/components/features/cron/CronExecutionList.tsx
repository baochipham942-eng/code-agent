import React from 'react';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import {
  formatDuration,
  formatRunCostUsd,
  formatRunListTime,
  getExecutionStatusMeta,
  isPermissionDeniedExecution,
} from './types';
import { wakeSkipSentence } from './wakeSkipSentence';
import { CronRunsOnPill } from './CronRunsOnSelector';
import { awaitingApprovalLabel } from './awaitingApprovalLabel';

interface CronExecutionListProps {
  executions: CronJobExecution[];
  selectedExecutionId: string | null;
  onSelectExecution: (executionId: string) => void;
  /** 跨任务执行流（运行记录 tab）时传入：加一列任务名 */
  jobNameById?: Record<string, string>;
  /** Immutable execution location keyed by job id. */
  runsOnByJobId?: Record<string, CronJobDefinition['runsOn']>;
  /** jobId → 等批准运行（N-CRON-UNATTENDED-BASH-PARK-STUCK）：running 行状态格换 amber 徽章。 */
  awaitingByJobId?: Map<string, { commandPreview?: string }>;
}

const thClass = 'whitespace-nowrap px-1 py-2';
const tdClass = 'px-1 py-2';

function executionColumnCount(hasJob: boolean, hasLocation: boolean): number {
  // 状态、计划、开始、耗时、成本、重试、退出码，外加可选的任务名与位置。
  return 7 + (hasJob ? 1 : 0) + (hasLocation ? 1 : 0);
}

export const CronExecutionList: React.FC<CronExecutionListProps> = ({
  executions,
  selectedExecutionId,
  onSelectExecution,
  jobNameById,
  runsOnByJobId,
  awaitingByJobId,
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  if (executions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
        {cc.execEmpty}
      </div>
    );
  }

  const columnCount = executionColumnCount(Boolean(jobNameById), Boolean(runsOnByJobId));

  return (
    <div
      className="min-w-0 overflow-x-auto rounded-xl border border-zinc-800"
      data-testid="cron-execution-table-scroll"
    >
      <table className="w-full text-sm">
        <thead className="bg-zinc-950/80 text-left text-xs text-zinc-500">
          <tr>
            {jobNameById && <th className={thClass}>{cc.colJob}</th>}
            <th className={thClass}>{cc.colStatus}</th>
            {runsOnByJobId && <th className={thClass}>{cc.colLocation}</th>}
            <th className={thClass}>{cc.colScheduledAt}</th>
            <th className={thClass}>{cc.colStartedAt}</th>
            <th className={thClass}>{cc.colDuration}</th>
            <th className={thClass}>{cc.colCost}</th>
            <th className={thClass}>{cc.colRetry}</th>
            <th className={thClass}>{cc.colExitCode}</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((execution) => {
            const statusMeta = getExecutionStatusMeta(execution.status);
            // 需处理（N-CRON-RUN-COMPLETED-BUT-DENIED）：被拒且无产出的完成运行换琥珀徽章。
            const permissionDenied = isPermissionDeniedExecution(execution);
            const wakeSkipText = wakeSkipSentence(execution, {
              silentLevel: cc.wakeSkipSilentLevel,
              dailyBudget: cc.wakeSkipDailyBudget,
              quietHours: cc.wakeSkipQuietHours,
            });
            const costRunsOn = execution.runsOn ?? runsOnByJobId?.[execution.jobId];
            const awaitingPreview = awaitingByJobId?.get(execution.jobId)?.commandPreview;
            const isSelected = execution.id === selectedExecutionId;
            const rowTone = isSelected ? 'bg-zinc-800/80' : 'bg-zinc-900/40 hover:bg-zinc-800/50';
            return (
              <React.Fragment key={execution.id}>
                <tr
                  className={`cursor-pointer border-t border-zinc-800 transition-colors ${rowTone}`}
                  onClick={() => onSelectExecution(execution.id)}
                >
                  {jobNameById && (
                    <td className={`max-w-[200px] truncate text-zinc-200 ${tdClass}`}>
                      {jobNameById[execution.jobId] || execution.jobId}
                    </td>
                  )}
                  <td className={`whitespace-nowrap ${tdClass}`}>
                    {execution.status === 'running' && (awaitingByJobId?.has(execution.jobId) ?? false) ? (
                      <span
                        className="inline-block max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-badge-warning/40 bg-amber-500/15 px-2 py-1 align-middle text-xs text-badge-warning"
                        data-testid="cron-exec-awaiting-approval"
                        title={awaitingPreview ? cc.awaitingApprovalWithPreview.replace('{preview}', awaitingPreview) : undefined}
                      >
                        {awaitingApprovalLabel(cc.awaitingApprovalWithPreview, awaitingPreview) ?? cc.awaitingApprovalBadge}
                      </span>
                    ) : permissionDenied ? (
                      <span
                        className="rounded-full px-2 py-1 text-xs text-badge-warning bg-amber-500/10"
                        data-testid="cron-execution-permission-denied"
                      >
                        {cc.permissionDeniedBadge}
                      </span>
                    ) : (
                      <span className={`rounded-full px-2 py-1 text-xs ${statusMeta.className}`}>
                        {cc.status[execution.status]}
                      </span>
                    )}
                  </td>
                  {runsOnByJobId && (
                    <td className={tdClass}>
                      <CronRunsOnPill
                        runsOn={execution.runsOn ?? runsOnByJobId[execution.jobId] ?? 'local'}
                        localLabel={cc.locationLocal}
                        cloudLabel={cc.locationCloud}
                      />
                    </td>
                  )}
                  <td className={`whitespace-nowrap text-zinc-300 tabular-nums ${tdClass}`}>{formatRunListTime(execution.scheduledAt)}</td>
                  <td className={`whitespace-nowrap text-zinc-400 tabular-nums ${tdClass}`}>{formatRunListTime(execution.startedAt)}</td>
                  <td className={`whitespace-nowrap text-zinc-300 ${tdClass}`}>{formatDuration(execution.duration)}</td>
                  <td className={`whitespace-nowrap text-zinc-300 tabular-nums ${tdClass}`} data-testid="cron-execution-cost-cell">{formatRunCostUsd(execution.cost, costRunsOn)}</td>
                  <td className={`whitespace-nowrap text-zinc-300 ${tdClass}`}>{execution.retryAttempt}</td>
                  <td className={`whitespace-nowrap text-zinc-300 ${tdClass}`}>
                    {execution.exitCode != null ? execution.exitCode : '—'}
                  </td>
                </tr>
                {wakeSkipText && (
                  <tr
                    className={`cursor-pointer transition-colors ${rowTone}`}
                    onClick={() => onSelectExecution(execution.id)}
                  >
                    {/* 原因不进状态格：状态列保持徽章宽度，句子横跨整行，避免折成多行把表头挤竖。 */}
                    <td
                      colSpan={columnCount}
                      className="px-2 pb-2 text-xs text-zinc-500"
                      data-testid="cron-wake-skip-reason"
                    >
                      {wakeSkipText}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default CronExecutionList;
