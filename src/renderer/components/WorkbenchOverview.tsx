// ============================================================================
// WorkbenchOverview - 任务工作台。
// 默认固定展示 Todo / 上下文 / 产物；产物被点击后切成专注预览，返回后恢复
// 工作台。审批与 ask-user 问题留在会话链路，不投影到概览。
// ============================================================================

import React, { useEffect } from 'react';
import { Activity, ArrowLeft } from 'lucide-react';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../hooks/useI18n';
import { useTaskActivity } from '../hooks/useTaskActivity';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useAppStore } from '../stores/appStore';
import { useRunControlStore } from '../stores/runControlStore';
import { useSessionStore } from '../stores/sessionStore';
import { TaskPanel } from './TaskPanel';
import { WorkspacePreviewPanel } from './WorkspacePreviewPanel';

export const WorkbenchOverview: React.FC = () => {
  const { t } = useI18n();
  const { hasTaskActivity, agentTreeSnapshot } = useTaskActivity();
  const workspacePreviewItems = useWorkspacePreviewModel();
  const hasArtifacts = workspacePreviewItems.length > 0;
  const hasQueuedInputs = useRunControlStore((state) => state.queue.length > 0);
  const selectedWorkspacePreviewId = useAppStore((state) => state.selectedWorkspacePreviewId);
  const setSelectedWorkspacePreviewId = useAppStore((state) => state.setSelectedWorkspacePreviewId);
  const hasSelectedArtifact = selectedWorkspacePreviewId
    ? workspacePreviewItems.some((item) => item.id === selectedWorkspacePreviewId)
    : false;
  // 最近一次任务现场摘要：纯对话（PLAIN_CHAT_SUMMARY_LABEL）不算产物现场，不挂预览。
  const recentSnapshotSummary = useSessionStore((state) => {
    const summary = state.sessions
      .find((session) => session.id === state.currentSessionId)
      ?.workbenchSnapshot?.summary?.trim();
    return summary && summary !== PLAIN_CHAT_SUMMARY_LABEL ? summary : null;
  });

  useEffect(() => {
    if (selectedWorkspacePreviewId && !hasSelectedArtifact) {
      setSelectedWorkspacePreviewId(null);
    }
  }, [hasSelectedArtifact, selectedWorkspacePreviewId, setSelectedWorkspacePreviewId]);

  if (selectedWorkspacePreviewId && hasSelectedArtifact) {
    return (
      <div
        data-testid="workbench-overview-preview"
        className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900"
      >
        <button
          type="button"
          onClick={() => setSelectedWorkspacePreviewId(null)}
          className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 text-xs text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t.workbenchTabs.overviewBackLabel}
        </button>
        <div className="min-h-0 flex-1">
          <WorkspacePreviewPanel overviewMode />
        </div>
      </div>
    );
  }

  // 排队消息必须始终可达（T1）：中断后 run 活动信号会落回 false，但队列还在，
  // 只按 hasTaskActivity 判空态会把「可见、可删、可立即发送」直接锁死在空态后面。
  if (!hasTaskActivity && !hasArtifacts && !hasQueuedInputs) {
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
          {/* 空态是一张卡（2026-07-26 打磨批 D D7）：叙事与「最近产物」同属一个
              视觉体，产物块用分隔线收进卡内，不再两行孤立浮在叙事下方。 */}
          <div className="w-full max-w-sm rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-6">
            <Activity className="mx-auto h-8 w-8 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">{t.workbenchTabs.overviewEmptyNarrative}</div>
            {recentSnapshotSummary && (
              <div
                data-testid="workbench-overview-recent"
                className="mt-4 border-t border-white/[0.06] pt-3 text-left"
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t.workbenchTabs.overviewEmptyRecentLabel}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-zinc-400">{recentSnapshotSummary}</div>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      data-testid="workbench-overview-view"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-900"
    >
      <section
        data-testid="workbench-overview-workspace"
        aria-label={t.workbenchTabs.overviewTitle}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1">
          <TaskPanel agentTreeSnapshot={agentTreeSnapshot} />
        </div>
      </section>
    </div>
  );
};
