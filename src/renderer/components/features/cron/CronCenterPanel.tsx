import React, { useEffect, useMemo } from 'react';
import { Clock3 } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { CronJobList } from './CronJobList';
import { AutomationReviewInbox } from './AutomationReviewInbox';
import { CronJobDetail } from './CronJobDetail';
import { CronJobEditor } from './CronJobEditor';
import { WebModeBanner } from '../settings/WebModeBanner';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

interface CronCenterPanelProps {
  onClose: () => void;
}

export const CronCenterPanel: React.FC<CronCenterPanelProps> = ({ onClose }) => {
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isEditorOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditorOpen, onClose]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId]
  );

  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) || null,
    [jobs, editingJobId]
  );

  return (
    <FullScreenPage testId="cron-center-panel">
      <FullScreenPageHeader
        icon={<Clock3 className="h-4 w-4 text-amber-300" />}
        title={cc.title}
        description={cc.subtitle}
        onClose={onClose}
        closeLabel={cc.close}
        actions={stats ? (
          <div className="hidden items-center gap-2 text-xs text-zinc-400 xl:flex">
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{cc.statTotal} {stats.totalJobs}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{cc.statActive} {stats.activeJobs}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{automationText.stats.totalExecutions} {stats.totalExecutions} ({stats.successfulExecutions}{automationText.stats.successfulExecutionsSuffix})</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">{automationText.stats.failedExecutions} {stats.failedExecutions}</span>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1">
            {cc.statRate} {stats.successRate.toFixed(0)}%
          </span>
          </div>
        ) : null}
      />

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
    </FullScreenPage>
  );
};

export default CronCenterPanel;
