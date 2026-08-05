// ============================================================================
// WorkbenchOverview - 任务工作台。
// 默认固定展示 Todo / 上下文 / 产物。产物点击直接打开原生 preview tab；
// 审批与 ask-user 问题留在会话链路，不投影到概览。
// ============================================================================

import React from 'react';
import { Activity } from 'lucide-react';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../hooks/useI18n';
import { useTaskActivity } from '../hooks/useTaskActivity';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useSessionStore } from '../stores/sessionStore';
import { TaskPanel } from './TaskPanel';

export const WorkbenchOverview: React.FC = () => {
  const { t } = useI18n();
  // agentTree 快照只参与 hasTaskActivity 判空（数据链路不动），UI 不再展示（拍板三）
  const { hasTaskActivity } = useTaskActivity();
  const workspacePreviewItems = useWorkspacePreviewModel();
  const hasArtifacts = workspacePreviewItems.length > 0;
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
          {/* 空态样式重做（2026-08-04 四模块）：去卡片边框与底面色块，图标 + 一行
              叙事 + 留白隔开的「最近产物」小节，不用 border-t 分隔线（条款 B2/B4）。 */}
          <Activity className="h-8 w-8 text-zinc-600" />
          <div className="mt-3 text-sm text-zinc-400">{t.workbenchTabs.overviewEmptyNarrative}</div>
          {recentSnapshotSummary && (
            <div
              data-testid="workbench-overview-recent"
              className="mt-8 w-full max-w-sm text-left"
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {t.workbenchTabs.overviewEmptyRecentLabel}
              </div>
              <div className="mt-1.5 text-xs leading-relaxed text-zinc-500">{recentSnapshotSummary}</div>
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
      <section
        data-testid="workbench-overview-workspace"
        aria-label={t.workbenchTabs.overviewTitle}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1">
          <TaskPanel />
        </div>
      </section>
    </div>
  );
};
