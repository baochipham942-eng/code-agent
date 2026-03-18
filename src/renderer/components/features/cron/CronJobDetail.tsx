import React, { useEffect, useMemo, useState } from 'react';
import type { CronJobDefinition } from '@shared/types';
import { Activity, Pencil, Play, Power, Trash2 } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import {
  formatActionSummary,
  formatDateTime,
  formatScheduleSummary,
  getLatestExecutionStatus,
} from './types';
import { CronExecutionList } from './CronExecutionList';
import { CronExecutionDetail } from './CronExecutionDetail';

interface CronJobDetailProps {
  job: CronJobDefinition | null;
}

export const CronJobDetail: React.FC<CronJobDetailProps> = ({ job }) => {
  const {
    executionsByJobId,
    latestExecutions,
    loadExecutions,
    openEditEditor,
    updateJob,
    deleteJob,
    triggerJob,
  } = useCronStore();
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  useEffect(() => {
    if (!job) return;
    loadExecutions(job.id);
  }, [job, loadExecutions]);

  useEffect(() => {
    if (!job) {
      setSelectedExecutionId(null);
      return;
    }
    const executions = executionsByJobId[job.id] || [];
    setSelectedExecutionId((current) =>
      current && executions.some((execution) => execution.id === current)
        ? current
        : executions[0]?.id || null
    );
  }, [job, executionsByJobId]);

  const executions = job ? executionsByJobId[job.id] || [] : [];
  const selectedExecution = useMemo(
    () => executions.find((execution) => execution.id === selectedExecutionId) || null,
    [executions, selectedExecutionId]
  );

  if (!job) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-900/40">
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center">
          <div className="text-sm text-zinc-300">选择一个定时任务查看详情</div>
          <div className="mt-2 text-xs text-zinc-500">也可以直接新建第一个任务</div>
        </div>
      </div>
    );
  }

  const latestMeta = getLatestExecutionStatus(latestExecutions[job.id]);

  const handleToggleEnabled = async () => {
    await updateJob(job.id, { enabled: !job.enabled });
  };

  const handleDelete = async () => {
    if (!window.confirm(`确认删除任务 “${job.name}” 吗？`)) return;
    await deleteJob(job.id);
  };

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      await triggerJob(job.id);
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-zinc-900/40">
      <div className="border-b border-zinc-800 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-zinc-100">{job.name}</h3>
              <span className={`rounded-full px-2 py-1 text-xs ${latestMeta.className}`}>
                最近: {latestMeta.label}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-zinc-400">
              {job.description || '暂无描述'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => openEditEditor(job.id)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </button>
            <button
              onClick={handleToggleEnabled}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Power className="h-3.5 w-3.5" />
              {job.enabled ? '停用' : '启用'}
            </button>
            <button
              onClick={handleTrigger}
              disabled={isTriggering}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-blue-400 transition-colors hover:bg-blue-500/10 hover:text-blue-300 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {isTriggering ? '执行中…' : '手动触发'}
            </button>
            <button
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          <InfoCard label="调度" value={formatScheduleSummary(job)} />
          <InfoCard label="动作" value={formatActionSummary(job)} />
          <InfoCard label="创建时间" value={formatDateTime(job.createdAt)} />
          <InfoCard label="更新时间" value={formatDateTime(job.updatedAt)} />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          <InfoCard label="启用状态" value={job.enabled ? '启用' : '停用'} />
          <InfoCard label="最大重试" value={job.maxRetries != null ? String(job.maxRetries) : '0'} />
          <InfoCard label="重试间隔" value={job.retryDelay != null ? `${job.retryDelay}ms` : '—'} />
          <InfoCard label="超时" value={job.timeout != null ? `${job.timeout}ms` : '—'} />
        </div>

        {job.tags && job.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {job.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-300" />
          <h4 className="text-sm font-medium text-zinc-100">执行历史</h4>
        </div>
        {executions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-8 text-center text-sm text-zinc-500">
            还没有执行记录，点击「手动触发」运行一次
          </div>
        ) : (
          <div className="grid min-h-0 gap-4 xl:grid-cols-[1.4fr_1fr]">
            <section className="min-h-0 overflow-y-auto">
              <CronExecutionList
                executions={executions}
                selectedExecutionId={selectedExecutionId}
                onSelectExecution={setSelectedExecutionId}
              />
            </section>
            <section className="min-h-0 overflow-y-auto">
              <CronExecutionDetail execution={selectedExecution} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

const InfoCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
    <div className="text-xs text-zinc-500">{label}</div>
    <div className="mt-1 text-sm text-zinc-200">{value}</div>
  </div>
);

export default CronJobDetail;
