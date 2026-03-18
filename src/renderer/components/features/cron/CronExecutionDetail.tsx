import React from 'react';
import type { CronJobExecution } from '@shared/types';
import {
  formatDateTime,
  formatDuration,
  getExecutionStatusMeta,
  prettyJson,
} from './types';

interface CronExecutionDetailProps {
  execution: CronJobExecution | null;
}

export const CronExecutionDetail: React.FC<CronExecutionDetailProps> = ({ execution }) => {
  if (!execution) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
        选择一条执行记录查看详情
      </div>
    );
  }

  const statusMeta = getExecutionStatusMeta(execution.status);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-zinc-100">执行详情</h4>
          <p className="mt-1 text-xs text-zinc-500">{execution.id}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs ${statusMeta.className}`}>
          {statusMeta.label}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Info label="计划时间" value={formatDateTime(execution.scheduledAt)} />
        <Info label="开始时间" value={formatDateTime(execution.startedAt)} />
        <Info label="完成时间" value={formatDateTime(execution.completedAt)} />
        <Info label="耗时" value={formatDuration(execution.duration)} />
        <Info label="重试次数" value={String(execution.retryAttempt)} />
        <Info label="退出码" value={execution.exitCode != null ? String(execution.exitCode) : '—'} />
      </div>

      {execution.error && (
        <section className="mt-4">
          <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-red-300">错误</h5>
          <pre className="max-h-40 overflow-auto rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-100 whitespace-pre-wrap">
            {execution.error}
          </pre>
        </section>
      )}

      <section className="mt-4">
        <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">结果</h5>
        <pre className="max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 whitespace-pre-wrap">
          {prettyJson(execution.result)}
        </pre>
      </section>
    </div>
  );
};

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
    <div className="text-xs text-zinc-500">{label}</div>
    <div className="mt-1 text-sm text-zinc-200">{value}</div>
  </div>
);

export default CronExecutionDetail;
