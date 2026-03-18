import React from 'react';
import type { CronJobExecution } from '@shared/types';
import {
  formatDateTime,
  formatDuration,
  getExecutionStatusMeta,
} from './types';

interface CronExecutionListProps {
  executions: CronJobExecution[];
  selectedExecutionId: string | null;
  onSelectExecution: (executionId: string) => void;
}

export const CronExecutionList: React.FC<CronExecutionListProps> = ({
  executions,
  selectedExecutionId,
  onSelectExecution,
}) => {
  if (executions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
        还没有执行记录
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-950/80 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2">计划时间</th>
            <th className="px-3 py-2">开始时间</th>
            <th className="px-3 py-2">耗时</th>
            <th className="px-3 py-2">重试</th>
            <th className="px-3 py-2">退出码</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((execution) => {
            const statusMeta = getExecutionStatusMeta(execution.status);
            const isSelected = execution.id === selectedExecutionId;
            return (
              <tr
                key={execution.id}
                className={`cursor-pointer border-t border-zinc-800 transition-colors ${
                  isSelected ? 'bg-zinc-800/80' : 'bg-zinc-900/40 hover:bg-zinc-800/50'
                }`}
                onClick={() => onSelectExecution(execution.id)}
              >
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-1 text-xs ${statusMeta.className}`}>
                    {statusMeta.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-300">{formatDateTime(execution.scheduledAt)}</td>
                <td className="px-3 py-2 text-zinc-400">{formatDateTime(execution.startedAt)}</td>
                <td className="px-3 py-2 text-zinc-300">{formatDuration(execution.duration)}</td>
                <td className="px-3 py-2 text-zinc-300">{execution.retryAttempt}</td>
                <td className="px-3 py-2 text-zinc-300">
                  {execution.exitCode != null ? execution.exitCode : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default CronExecutionList;
