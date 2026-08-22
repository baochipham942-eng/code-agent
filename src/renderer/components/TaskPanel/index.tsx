// ============================================================================
// TaskPanel - Right-side panel
// ----------------------------------------------------------------------------
// 主视图：概览四模块（任务 / Todo / 上下文 / 产物）
// 深度视图：检查器（N-LEDGER-P1，D2 拍板挂这里）——两层视图 + 实际组装面板，
// 实现全部在 ./SessionInspector/，本文件只留 tab 切换。
// 本会话的代理（N-L6-AGENTVIEW S2）：专家 + 普通代理 + 后台任务一列看完；
// 页签选中态在 taskPanelViewStore（成员条折叠 chip 从外面切过来）。
// ============================================================================

import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useTaskPanelViewStore, type TaskPanelView } from '../../stores/taskPanelViewStore';
import { TaskWorkspaceOverview } from './TaskWorkspaceOverview';
import { SessionInspector } from './SessionInspector';
import { SessionAgentsPanel } from './SessionAgentsPanel';

export const TaskPanel: React.FC<{ overviewContent?: React.ReactNode }> = ({ overviewContent }) => {
  const { t } = useI18n();
  const view = useTaskPanelViewStore((state) => state.view);
  const setView = useTaskPanelViewStore((state) => state.setView);
  const tabs: Array<{ key: TaskPanelView; label: string }> = [
    { key: 'overview', label: t.sessionInspector.overviewTabLabel },
    { key: 'inspector', label: t.sessionInspector.tabLabel },
    { key: 'agents', label: t.expert.memberBar.panel.title },
  ];
  return (
    <div className="w-full h-full bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-3 pt-2 pb-1.5" data-testid="task-panel-tabs">
        {tabs.map((item) => (
          <button /* ds-allow:button: tab 切换是超小文本按钮，primitive 最小档仍过大 */
            key={item.key}
            type="button"
            data-testid={`task-panel-tab-${item.key}`}
            aria-pressed={view === item.key}
            onClick={() => setView(item.key)}
            className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
              view === item.key
                ? 'bg-surface-subtle text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {view === 'agents' ? (
          <SessionAgentsPanel />
        ) : view === 'overview' ? (
          overviewContent ?? <TaskWorkspaceOverview />
        ) : (
          <SessionInspector />
        )}
      </div>
    </div>
  );
};

export default TaskPanel;
