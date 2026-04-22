// ============================================================================
// TaskPanel - Right-side panel with three tabs: 状态 | 概览 | 编排
// ============================================================================

import React, { useEffect } from 'react';
import { TaskMonitor } from './TaskMonitor';
import { Orchestration } from './Orchestration';
import { Connectors } from './Connectors';
import { Users } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useAppStore, type TaskPanelTab } from '../../stores/appStore';
import { useSwarmStore } from '../../stores/swarmStore';

export const TaskPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    taskPanelTab,
    setTaskPanelTab,
    selectedSwarmAgentId,
    setShowAgentTeamPanel,
  } = useAppStore();
  const { isRunning, agents, launchRequests, planReviews, aggregation } = useSwarmStore();
  const selectedAgent = agents.find((agent) => agent.id === selectedSwarmAgentId) ?? null;

  const hasOrchestrationData =
    isRunning || agents.length > 0 || launchRequests.length > 0 || planReviews.length > 0 || Boolean(aggregation);
  const hasPendingLaunch = launchRequests.some((request) => request.status === 'pending');

  useEffect(() => {
    if ((isRunning || hasPendingLaunch) && taskPanelTab !== 'orchestration') {
      setTaskPanelTab('orchestration');
    }
  }, [hasPendingLaunch, isRunning, setTaskPanelTab, taskPanelTab]);

  const tabs: Array<{ key: TaskPanelTab; label: string; visible: boolean }> = [
    { key: 'monitor', label: t.taskPanel.tabStatus, visible: true },
    { key: 'overview', label: t.taskPanel.tabOverview, visible: true },
    { key: 'orchestration', label: t.taskPanel.tabOrchestration, visible: hasOrchestrationData },
  ];

  return (
    <div className="w-full h-full border-l border-white/[0.06] bg-zinc-900 flex flex-col overflow-hidden">
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          {selectedAgent && (
            <button
              onClick={() => setShowAgentTeamPanel(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-300 transition-colors hover:bg-cyan-500/15"
              title={`查看 ${selectedAgent.name}`}
            >
              <Users className="h-3 w-3" />
              <span className="max-w-[140px] truncate">{selectedAgent.name}</span>
            </button>
          )}
          <div className="flex items-center gap-1 rounded-lg bg-zinc-800/80 p-1">
            {tabs.filter((tab) => tab.visible).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setTaskPanelTab(tab.key)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  taskPanelTab === tab.key
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {taskPanelTab === 'orchestration' && hasOrchestrationData ? (
          <Orchestration />
        ) : taskPanelTab === 'overview' ? (
          <OverviewTab />
        ) : (
          <TaskMonitor />
        )}
      </div>
    </div>
  );
};

// ── 概览 Tab: Intervention + Provenance + Connectors ──

const OverviewTab: React.FC = () => {
  return (
    <div className="space-y-4">
      <Connectors />
    </div>
  );
};

export default TaskPanel;
