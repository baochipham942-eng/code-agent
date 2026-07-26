// ============================================================================
// WorkbenchOverview - 任务现场。
// 有任务活动时：「任务进程 + 产物」双区。会话已有产物但无任务活动时仍展示
// 产物区（跑完的任务/重开的会话不能让产物消失）。既无活动也无产物时不摆
// 空产物壳，给任务现场叙事（运行中的任务会实时显示在这里），并把当前会话
// workbenchSnapshot 里最近一次任务现场摘要作为「最近产物」预览挂出来。
// ============================================================================

import React from 'react';
import { Activity } from 'lucide-react';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../hooks/useI18n';
import { useTaskActivity } from '../hooks/useTaskActivity';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useSessionStore } from '../stores/sessionStore';
import { TaskPanel } from './TaskPanel';
import { WorkspacePreviewPanel } from './WorkspacePreviewPanel';

export const WorkbenchOverview: React.FC = () => {
  const { t } = useI18n();
  const { hasTaskActivity, agentTreeSnapshot } = useTaskActivity();
  const hasArtifacts = useWorkspacePreviewModel().length > 0;
  // 最近一次任务现场摘要：纯对话（PLAIN_CHAT_SUMMARY_LABEL）不算产物现场，不挂预览。
  const recentSnapshotSummary = useSessionStore((state) => {
    const summary = state.sessions
      .find((session) => session.id === state.currentSessionId)
      ?.workbenchSnapshot?.summary?.trim();
    return summary && summary !== PLAIN_CHAT_SUMMARY_LABEL ? summary : null;
  });

  if (!hasTaskActivity && !hasArtifacts) {
    return (
      <div
        data-testid="workbench-overview-view"
        className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900"
      >
        <section
          data-testid="workbench-overview-empty"
          aria-label={t.workbenchTabs.overviewTitle}
          className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center"
        >
          <Activity className="h-8 w-8 text-zinc-600" />
          <div className="mt-3 text-sm text-zinc-300">{t.workbenchTabs.overviewEmptyNarrative}</div>
          {recentSnapshotSummary && (
            <div
              data-testid="workbench-overview-recent"
              className="mt-4 w-full max-w-sm rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left"
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {t.workbenchTabs.overviewEmptyRecentLabel}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-zinc-400">{recentSnapshotSummary}</div>
            </div>
          )}
        </section>
      </div>
    );
  }

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
