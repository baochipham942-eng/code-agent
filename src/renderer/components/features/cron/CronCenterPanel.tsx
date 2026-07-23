import React, { useEffect, useMemo } from 'react';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { CronJobList } from './CronJobList';
import { AutomationReviewInbox } from './AutomationReviewInbox';
import { CronJobDetail } from './CronJobDetail';
import { CronJobEditor } from './CronJobEditor';
import { WebModeBanner } from '../settings/WebModeBanner';
export const CronCenterPanel: React.FC = () => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const automationText = t.settings.automation;
  const {
    jobs,
    stats,
    selectedJobId,
    isEditorOpen,
    editingJobId,
    isLoading,
    error,
    refresh,
    closeEditor,
  } = useCronStore();

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId]
  );

  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) || null,
    [jobs, editingJobId]
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cron-center-panel">
      {stats ? (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3 text-xs text-zinc-400">
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{cc.statTotal} {stats.totalJobs}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{cc.statActive} {stats.activeJobs}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{automationText.stats.totalExecutions} {stats.totalExecutions} ({stats.successfulExecutions}{automationText.stats.successfulExecutionsSuffix})</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{automationText.stats.failedExecutions} {stats.failedExecutions}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">
            {cc.statRate} {stats.successRate.toFixed(0)}%
          </span>
        </div>
      ) : null}

      <WebModeBanner />

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-5 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <AutomationReviewInbox />

      <div className="grid min-h-0 flex-1 grid-cols-[360px_1fr] overflow-hidden">
        <CronJobList />
        <div className="min-w-0">
          {isLoading && jobs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              {cc.loading}
            </div>
          ) : (
            <CronJobDetail job={selectedJob} />
          )}
        </div>
      </div>

      <CronJobEditor
        isOpen={isEditorOpen}
        job={editingJob}
        onClose={closeEditor}
      />
    </div>
  );
};

export default CronCenterPanel;
