import React, { useEffect, useMemo } from 'react';
import { Clock3, X } from 'lucide-react';
import { useCronStore } from '../../../stores/cronStore';
import { CronJobList } from './CronJobList';
import { CronJobDetail } from './CronJobDetail';
import { CronJobEditor } from './CronJobEditor';

interface CronCenterPanelProps {
  onClose: () => void;
}

export const CronCenterPanel: React.FC<CronCenterPanelProps> = ({ onClose }) => {
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
      if (event.key === 'Escape' && !isEditorOpen) {
        onClose();
      }
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
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      <div
        className="flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-3">
          <Clock3 className="h-5 w-5 text-amber-300" />
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Cron Center</h2>
            <p className="text-xs text-zinc-500">定时任务调度、执行历史与运行状态</p>
          </div>
          {stats && (
            <div className="ml-6 hidden items-center gap-2 text-xs text-zinc-400 md:flex">
              <span className="rounded-full bg-zinc-900 px-2.5 py-1">总任务 {stats.totalJobs}</span>
              <span className="rounded-full bg-zinc-900 px-2.5 py-1">启用 {stats.activeJobs}</span>
              <span className="rounded-full bg-zinc-900 px-2.5 py-1">
                成功率 {stats.successRate.toFixed(0)}%
              </span>
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-5 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[360px_1fr] overflow-hidden">
        <CronJobList />
        <div className="min-w-0">
          {isLoading && jobs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              正在加载定时任务...
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
