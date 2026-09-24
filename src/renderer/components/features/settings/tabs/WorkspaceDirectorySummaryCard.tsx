import React from 'react';
import type { WorkspaceDirectorySummary } from '@shared/contract';

type DirectorySummaryLabels = {
  summaryTitle: string;
  summaryLoading: string;
  summaryUnavailable: string;
  gitRepository: string;
  gitRepositoryYes: string;
  gitRepositoryNo: string;
  gitBranch: string;
  gitDirtyFiles: string;
  recentSessions: string;
  notAvailable: string;
};

export const WorkspaceDirectorySummaryCard: React.FC<{
  summary: WorkspaceDirectorySummary | null;
  loading: boolean;
  labels: DirectorySummaryLabels;
}> = ({ summary, loading, labels }) => (
  <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
    <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">{labels.summaryTitle}</div>
    {loading ? (
      <div className="mt-2 text-[11px] text-zinc-500">{labels.summaryLoading}</div>
    ) : summary ? (
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-zinc-500">{labels.gitRepository}</div>
          <div className="mt-0.5 text-zinc-200">
            {summary.git.isRepository ? labels.gitRepositoryYes : labels.gitRepositoryNo}
          </div>
        </div>
        <div>
          <div className="text-zinc-500">{labels.gitBranch}</div>
          <div className="mt-0.5 truncate font-mono text-zinc-200">
            {summary.git.branch || labels.notAvailable}
          </div>
        </div>
        <div>
          <div className="text-zinc-500">{labels.gitDirtyFiles}</div>
          <div className="mt-0.5 text-zinc-200">{summary.git.dirtyFiles}</div>
        </div>
        <div>
          <div className="text-zinc-500">{labels.recentSessions}</div>
          <div className="mt-0.5 text-zinc-200">{summary.recentSessionCount}</div>
        </div>
      </div>
    ) : (
      <div className="mt-2 text-[11px] text-zinc-500">{labels.summaryUnavailable}</div>
    )}
  </div>
);
