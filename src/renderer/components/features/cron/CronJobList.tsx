import React, { useMemo } from 'react';
import { Play, Plus, RefreshCw } from 'lucide-react';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { useCronStore } from '../../../stores/cronStore';
import {
  formatScheduleSummary,
  formatScheduleType,
  getLatestExecutionStatus,
} from './types';

export const CronJobList: React.FC = () => {
  const {
    jobs,
    latestExecutions,
    selectedJobId,
    filterMode,
    searchQuery,
    isLoading,
    setFilterMode,
    setSearchQuery,
    selectJob,
    openCreateEditor,
    refresh,
  } = useCronStore();

  const filteredJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) => {
      const haystacks = [
        job.name,
        job.description || '',
        job.tags?.join(' ') || '',
      ];
      return haystacks.some((value) => value.toLowerCase().includes(q));
    });
  }, [jobs, searchQuery]);

  return (
    <div className="flex h-full flex-col border-r border-zinc-800 bg-zinc-950/80">
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">定时任务</h3>
            <p className="mt-1 text-xs text-zinc-500">管理 cron / interval / one-time 调度</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => refresh()}
              disabled={isLoading}
              title="刷新列表"
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={openCreateEditor}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Plus className="h-3.5 w-3.5" />
              新建
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索任务名、描述、标签"
          />
          <Select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as typeof filterMode)}
            options={[
              { value: 'all', label: '全部任务' },
              { value: 'enabled', label: '仅启用' },
              { value: 'disabled', label: '仅停用' },
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filteredJobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
            {jobs.length === 0 ? '还没有定时任务' : '没有匹配的任务'}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredJobs.map((job) => {
              const isSelected = job.id === selectedJobId;
              const latest = latestExecutions[job.id];
              const latestMeta = getLatestExecutionStatus(latest);
              return (
                <button
                  key={job.id}
                  onClick={() => selectJob(job.id)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    isSelected
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-100">{job.name}</div>
                      <div className="mt-1 text-xs text-zinc-500">{formatScheduleSummary(job)}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
                        job.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-zinc-500/10 text-zinc-300'
                      }`}
                    >
                      {job.enabled ? '启用' : '停用'}
                    </span>
                  </div>

                  {job.description && (
                    <div className="mt-2 line-clamp-2 text-xs text-zinc-400">{job.description}</div>
                  )}

                  <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                    <span className={`rounded-full px-2 py-1 ${latestMeta.className}`}>
                      最近: {latestMeta.label}
                    </span>
                    <span className="flex items-center gap-1 text-zinc-500">
                      <Play className="h-3 w-3" />
                      {formatScheduleType(job.scheduleType)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default CronJobList;
