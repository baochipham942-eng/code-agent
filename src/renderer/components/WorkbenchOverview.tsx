import React from 'react';
import { useI18n } from '../hooks/useI18n';
import { useTaskActivity } from '../hooks/useTaskActivity';
import { TaskPanel } from './TaskPanel';
import { WorkspacePreviewPanel } from './WorkspacePreviewPanel';

export const WorkbenchOverview: React.FC = () => {
  const { t } = useI18n();
  const { hasTaskActivity, agentTreeSnapshot } = useTaskActivity();

  return (
    <div
      data-testid="workbench-overview-view"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900"
    >
      {hasTaskActivity && (
        <section
          data-testid="workbench-overview-progress"
          aria-label={t.workbenchTabs.overviewProgressLabel}
          className="flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-white/[0.08]"
        >
          <h2 className="shrink-0 px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {t.workbenchTabs.overviewProgressLabel}
          </h2>
          <div className="min-h-0 flex-1">
            <TaskPanel agentTreeSnapshot={agentTreeSnapshot} />
          </div>
        </section>
      )}
      <section
        data-testid="workbench-overview-artifacts"
        aria-label={t.workbenchTabs.overviewArtifactsLabel}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* 产物区不再顶一行「产物」小标题：下面那条 header 就写着产物名，它自己说明自己。
            无障碍名仍由 section 的 aria-label 提供，没丢。 */}
        <div className="min-h-0 flex-1">
          <WorkspacePreviewPanel />
        </div>
      </section>
    </div>
  );
};
