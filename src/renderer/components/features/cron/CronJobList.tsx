// ============================================================================
// CronJobList —— 自动化中心左侧任务列表。
// 副标题说人话：cron 表达式经 utils/cronHumanize 翻成「每天 08:30 / 工作日 15:00」，
// 覆盖不了的形态回退原表达式；底部右侧触发源 chip（定时/一次性/循环/心跳/事件）
// 语义对齐 contract 的 SessionAutomationType，由 getCronTriggerKind 推导。
// ============================================================================

import React, { useMemo, useState } from 'react';
import type { CronRunsOn } from '@shared/contract';
import { Plus, RefreshCw } from 'lucide-react';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { getCronTriggerKind } from '../../../utils/cronHumanize';
import {
  formatDateTime,
  formatScheduleSummary,
  getLatestExecutionStatus,
} from './types';
import { CronRunsOnPill } from './CronRunsOnSelector';

type LocationFilter = 'all' | CronRunsOn;

export const CronJobList: React.FC = () => {
  const { t, language } = useI18n();
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
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');

  const filteredJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return jobs.filter((job) => {
      if (locationFilter !== 'all' && job.runsOn !== locationFilter) return false;
      if (!q) return true;
      const haystacks = [
        job.name,
        job.description || '',
        job.tags?.join(' ') || '',
      ];
      return haystacks.some((value) => value.toLowerCase().includes(q));
    });
  }, [jobs, searchQuery, locationFilter]);

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
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5" role="group" aria-label={cc.executionLocationTitle}>
            {([
              ['all', cc.locationFilterAll],
              ['local', cc.locationLocal],
              ['cloud', cc.locationCloud],
            ] as Array<[LocationFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setLocationFilter(value)}
                className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${locationFilter === value
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'}`}
                data-testid={`cron-location-filter-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
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
              const triggerKind = getCronTriggerKind(job);
              return (
                <button /* ds-allow:button: 任务列表行（多行内容左对齐布局），primitive 是居中动作按钮形状不适配 */
                  key={job.id}
                  onClick={() => selectJob(job.id)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    isSelected
                      ? 'border-badge-info/40 bg-blue-500/10'
                      : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-sm font-medium text-zinc-100">{job.name}</div>
                        <CronRunsOnPill runsOn={job.runsOn} localLabel={cc.locationLocal} cloudLabel={cc.locationCloud} />
                      </div>
                      <div className="mt-1 text-xs text-zinc-500" data-testid="cron-job-schedule-summary">
                        {formatScheduleSummary(job, language)}
                      </div>
                      {job.enabled && job.nextRunAt != null && (
                        <div className="mt-0.5 text-xs text-zinc-500" data-testid="cron-job-next-run">
                          {cc.nextRun.replace('{time}', formatDateTime(job.nextRunAt))}
                        </div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
                        job.enabled ? 'bg-emerald-500/10 text-badge-success' : 'bg-zinc-500/10 text-zinc-300'
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
                    {/* 触发源 chip：信息性标识统一中性 zinc，彩色只留给「要你处理的地方」 */}
                    <span
                      className="rounded-full border border-zinc-700/70 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400"
                      data-testid="cron-job-trigger-kind"
                    >
                      {cc.triggerKind[triggerKind]}
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
