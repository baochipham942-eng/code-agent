// ============================================================================
// WorkflowPanel - 工作流全屏页面（集成 DAGViewer）
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo, useCallback, useEffect } from 'react';
import { Workflow } from 'lucide-react';
import { DAGViewer } from './DAGViewer';
import { useDAGStore, useCurrentDAG, useDAGList } from '../../../stores/dagStore';
import { DAG_CHANNELS } from '@shared/ipc/channels';
import type { DAGVisualizationEvent } from '@shared/contract/dagVisualization';
import ipcService from '../../../services/ipcService';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

interface WorkflowPanelProps {
  /** 关闭回调 */
  onClose?: () => void;
}

/**
 * 工作流全屏页面
 */
export const WorkflowPanel = memo(({ onClose }: WorkflowPanelProps) => {
  const currentDAG = useCurrentDAG();
  const dagList = useDAGList();
  const { selectDAG, handleEvent } = useDAGStore();

  // 订阅 DAG 事件
  useEffect(() => {
    const handleDAGEvent = (event: DAGVisualizationEvent) => {
      handleEvent(event);
    };

    // 订阅 IPC 事件
    if (ipcService.isAvailable()) {
      ipcService.on(DAG_CHANNELS.EVENT, handleDAGEvent);
    }

    return () => {
      if (ipcService.isAvailable()) {
        ipcService.off(DAG_CHANNELS.EVENT, handleDAGEvent);
      }
    };
  }, [handleEvent]);

  // 处理关闭
  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  // 处理 DAG 选择
  const handleSelectDAG = useCallback(
    (dagId: string) => {
      selectDAG(dagId);
    },
    [selectDAG]
  );

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  return (
    <FullScreenPage testId="workflow-panel">
      <FullScreenPageHeader
        icon={<Workflow className="h-4 w-4 text-blue-400" />}
        title="Workflow"
        description="Agent 执行流程、DAG 状态和节点关系"
        onClose={handleClose}
        closeLabel="关闭 Workflow"
        actions={(
          <>
          {/* DAG 选择器（多个 DAG 时显示） */}
          {dagList.length > 1 && (
            <div
              className="flex items-center gap-1"
            >
              {dagList.map((dag) => (
                <button
                  key={dag.dagId}
                  onClick={() => handleSelectDAG(dag.dagId)}
                  className={`
                    px-3 py-1.5 text-sm rounded-lg transition-colors
                    ${
                      currentDAG?.dagId === dag.dagId
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }
                  `}
                >
                  {dag.name}
                </button>
              ))}
            </div>
          )}
          {/* 状态指示器 */}
          {currentDAG && (
            <DAGStatusBadge status={currentDAG.status} />
          )}
          </>
        )}
      />

      {/* DAG 视图 - 占据剩余空间 */}
      <div className="flex-1 min-h-0">
        <DAGViewer
          dagState={currentDAG}
          height="100%"
          showMiniMap={true}
          showControls={true}
          emptyMessage="暂无工作流。发送消息或执行任务后，这里会显示执行流程图。"
        />
      </div>
    </FullScreenPage>
  );
});

WorkflowPanel.displayName = 'WorkflowPanel';

/**
 * DAG 状态徽章
 */
const DAGStatusBadge = memo(({ status }: { status: string }) => {
  const statusConfig: Record<string, { color: string; label: string }> = {
    idle: { color: 'bg-gray-500', label: 'Idle' },
    running: { color: 'bg-blue-500 animate-pulse', label: 'Running' },
    paused: { color: 'bg-yellow-500', label: 'Paused' },
    completed: { color: 'bg-green-500', label: 'Completed' },
    failed: { color: 'bg-red-500', label: 'Failed' },
    cancelled: { color: 'bg-gray-500', label: 'Cancelled' },
  };

  const config = statusConfig[status] || statusConfig.idle;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${config.color} text-white`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-white ${status === 'running' ? 'animate-ping' : ''}`} />
      {config.label}
    </span>
  );
});

DAGStatusBadge.displayName = 'DAGStatusBadge';

export default WorkflowPanel;
