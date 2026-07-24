import React from 'react';
import { useI18n } from '../hooks/useI18n';
import { TaskPanel } from './TaskPanel';
import { WorkspacePreviewPanel } from './WorkspacePreviewPanel';

export const WorkbenchOverview: React.FC = () => {
  const { t } = useI18n();

  return (
    <div
      data-testid="workbench-overview-view"
      className="grid h-full min-h-0 grid-rows-2 overflow-hidden bg-zinc-900"
    >
      <section
        data-testid="workbench-overview-progress"
        aria-label={t.workbenchTabs.overviewProgressLabel}
        className="flex min-h-0 flex-col border-b border-white/[0.08]"
      >
        <h2 className="shrink-0 px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          {t.workbenchTabs.overviewProgressLabel}
        </h2>
        <div className="min-h-0 flex-1">
          <TaskPanel />
        </div>
      </section>
      <section
        data-testid="workbench-overview-artifacts"
        aria-label={t.workbenchTabs.overviewArtifactsLabel}
        className="flex min-h-0 flex-col"
      >
        <h2 className="shrink-0 px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          {t.workbenchTabs.overviewArtifactsLabel}
        </h2>
        <div className="min-h-0 flex-1">
          <WorkspacePreviewPanel />
        </div>
      </section>
    </div>
  );
};
