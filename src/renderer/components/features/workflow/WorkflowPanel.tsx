// ============================================================================
// WorkflowPanel - 工作流面板（集成 DAGViewer）
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo, useCallback, useEffect } from 'react';
import { DAGViewer } from './DAGViewer';
import { useDAGStore, useCurrentDAG, useDAGList, useDAGVisible } from '../../../stores/dagStore';
import { DAG_CHANNELS } from '@shared/ipc/channels';
import type { DAGVisualizationEvent } from '@shared/types/dagVisualization';

interface WorkflowPanelProps {
  /** 面板高度 */
  height?: string | number;
  /** 是否可关闭 */
  closable?: boolean;
  /** 关闭回调 */
  onClose?: () => void;
}

/**
 * 工作流面板
 */
export const WorkflowPanel = memo(({ height = 400, closable = true, onClose }: WorkflowPanelProps) => {
  const currentDAG = useCurrentDAG();
  const dagList = useDAGList();
  // 注意：可见性由父组件 App.tsx 通过 showDAGPanel 控制，
  // 这里不再使用 dagStore.isVisible 判断
  const { selectDAG, handleEvent } = useDAGStore();

  // 订阅 DAG 事件
  useEffect(() => {
    const handleDAGEvent = (event: DAGVisualizationEvent) => {
      handleEvent(event);
    };

    // 订阅 IPC 事件
    if (window.electronAPI?.on) {
      window.electronAPI.on(DAG_CHANNELS.EVENT, handleDAGEvent);
    }

    return () => {
      if (window.electronAPI?.off) {
        window.electronAPI.off(DAG_CHANNELS.EVENT, handleDAGEvent);
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

  return (
    <div
      className="flex flex-col bg-gray-900 border-t border-gray-700"
      style={{ height }}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800/50">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-gray-200">Workflow</h2>

          {/* DAG 选择器（多个 DAG 时显示） */}
          {dagList.length > 1 && (
            <div className="flex items-center gap-1">
              {dagList.map((dag) => (
                <button
                  key={dag.dagId}
                  onClick={() => handleSelectDAG(dag.dagId)}
                  className={`
                    px-2 py-1 text-xs rounded transition-colors
                    ${
                      currentDAG?.dagId === dag.dagId
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }
                  `}
                >
                  {dag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 控制按钮 */}
        <div className="flex items-center gap-2">
          {/* 状态指示器 */}
          {currentDAG && (
            <DAGStatusBadge status={currentDAG.status} />
          )}

          {/* 关闭按钮 */}
          {closable && (
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-gray-700 transition-colors"
              title="Close workflow panel"
            >
              <svg
                className="w-4 h-4 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* DAG 视图 */}
      <div className="flex-1 min-h-0">
        <DAGViewer
          dagState={currentDAG}
          height="100%"
          showMiniMap={true}
          showControls={true}
          emptyMessage="No active workflow. Run a parallel agent task or workflow to see it here."
        />
      </div>
    </div>
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
