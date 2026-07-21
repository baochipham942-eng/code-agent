import React, { useMemo } from 'react';
import { Play, Plus, RefreshCw } from 'lucide-react';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import {
  formatDateTime,
  formatScheduleSummary,
  formatScheduleType,
  getLatestExecutionStatus,
} from './types';

export const CronJobList: React.FC = () => {
  const { t } = useI18n();
  const cc = t.cronCenter;
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
            <h3 className="text-sm font-medium text-zinc-100">{cc.listTitle}</h3>
            <p className="mt-1 text-xs text-zinc-500">{cc.listSubtitle}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button /* ds-allow:button: 面板头图标按钮 p-1.5，primitive 变体会渲染可见底色改变尺寸 */
              onClick={() => refresh()}
              disabled={isLoading}
              title={cc.refresh}
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button /* ds-allow:button: 描边超小尺寸按钮（py-1.5 text-xs），primitive 最小 sm 仍更大 */
              onClick={openCreateEditor}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Plus className="h-3.5 w-3.5" />
              {cc.create}
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={cc.searchPlaceholder}
          />
          <Select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as typeof filterMode)}
            options={[
              { value: 'all', label: cc.filterAll },
              { value: 'enabled', label: cc.filterEnabled },
              { value: 'disabled', label: cc.filterDisabled },
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filteredJobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
            {jobs.length === 0 ? cc.emptyNone : cc.emptyNoMatch}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredJobs.map((job) => {
              const isSelected = job.id === selectedJobId;
              const latest = latestExecutions[job.id];
              const latestMeta = getLatestExecutionStatus(latest);
              const latestLabel = cc.status[latest?.status ?? 'none'];
              return (
                <button /* ds-allow:button: 任务列表行（多行内容左对齐布局），primitive 是居中动作按钮形状不适配 */
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
                      {job.enabled && job.nextRunAt != null && (
                        <div className="mt-0.5 text-xs text-zinc-500" data-testid="cron-job-next-run">
                          {cc.nextRun.replace('{time}', formatDateTime(job.nextRunAt))}
                        </div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
                        job.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-zinc-500/10 text-zinc-300'
                      }`}
                    >
                      {job.enabled ? cc.enabled : cc.disabled}
                    </span>
                  </div>

                  {job.description && (
                    <div className="mt-2 line-clamp-2 text-xs text-zinc-400">{job.description}</div>
                  )}

                  <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                    <span className={`rounded-full px-2 py-1 ${latestMeta.className}`}>
                      {cc.latest.replace('{label}', latestLabel)}
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
