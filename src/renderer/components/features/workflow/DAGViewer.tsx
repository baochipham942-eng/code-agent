// ============================================================================
// DAGViewer - React Flow DAG 可视化主组件
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { TaskNode } from './TaskNode';
import { DependencyEdge } from './DependencyEdge';
import { TaskDetailPanel } from './TaskDetailPanel';
import { useDAGLayout } from './useDAGLayout';
import type {
  DAGLayoutOptions,
  TaskNodeData,
  DependencyEdgeData,
} from '../../../../shared/types/dagVisualization';
import type { DAGStatus, DAGStatistics } from '../../../../shared/types/taskDAG';
import {
  TASK_STATUS_COLORS,
  formatDuration,
  formatCost,
  calculateProgress,
} from '../../../../shared/types/dagVisualization';

// Re-export TaskNodeData for external use
export type { TaskNodeData };

// Local type aliases for React Flow
type TaskNodeFlowType = Node<TaskNodeData, 'task'>;
type DependencyEdgeFlowType = Edge<DependencyEdgeData>;

// 自定义节点类型
const nodeTypes = {
  task: TaskNode,
};

// 自定义边类型
const edgeTypes = {
  dependency: DependencyEdge,
};

// 默认边样式
const defaultEdgeOptions = {
  type: 'dependency',
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color: '#4B5563',
  },
};

/**
 * DAG 可视化状态（简化版，用于组件 props）
 */
export interface DAGVisualizationState {
  dagId: string;
  name: string;
  description?: string;
  status: DAGStatus;
  statistics: DAGStatistics;
  nodes: TaskNodeFlowType[];
  edges: DependencyEdgeFlowType[];
  criticalPath?: string[];
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

interface DAGViewerProps {
  dagState: DAGVisualizationState | null;
  layoutOptions?: Partial<DAGLayoutOptions>;
  showMiniMap?: boolean;
  showControls?: boolean;
  showBackground?: boolean;
  height?: string | number;
  onNodeClick?: (task: TaskNodeData) => void;
  emptyMessage?: string;
}

/**
 * DAG 可视化查看器
 */
export const DAGViewer = memo(({
  dagState,
  layoutOptions,
  showMiniMap = true,
  showControls = true,
  showBackground = true,
  height = '100%',
  onNodeClick,
  emptyMessage = 'No workflow to display',
}: DAGViewerProps) => {
  // 布局
  const { getLayoutedElements } = useDAGLayout(layoutOptions);

  // React Flow 状态
  const [nodes, setNodes, onNodesChange] = useNodesState<TaskNodeFlowType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DependencyEdgeFlowType>([]);

  // 选中的任务
  const [selectedTask, setSelectedTask] = useState<TaskNodeData | null>(null);

  // 当 DAG 状态变化时更新节点和边
  useEffect(() => {
    if (!dagState) {
      setNodes([]);
      setEdges([]);
      setSelectedTask(null);
      return;
    }

    // 应用布局
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      dagState.nodes as TaskNodeFlowType[],
      dagState.edges as DependencyEdgeFlowType[]
    );

    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [dagState, getLayoutedElements, setNodes, setEdges]);

  // 处理节点选择
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const taskNode = node as TaskNodeFlowType;
      setSelectedTask(taskNode.data);
      onNodeClick?.(taskNode.data);
    },
    [onNodeClick]
  );

  // 关闭详情面板
  const handleCloseDetail = useCallback(() => {
    setSelectedTask(null);
  }, []);

  // MiniMap 节点颜色
  const miniMapNodeColor = useCallback((node: Node) => {
    const taskNode = node as TaskNodeFlowType;
    return TASK_STATUS_COLORS[taskNode.data?.status || 'pending'].border;
  }, []);

  // 渲染空状态
  if (!dagState) {
    return (
      <div
        className="flex items-center justify-center bg-gray-900"
        style={{ height }}
      >
        <div className="text-center text-gray-500">
          <svg
            className="w-16 h-16 mx-auto mb-4 opacity-50"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
            />
          </svg>
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex" style={{ height }}>
      {/* React Flow 画布 */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className="bg-gray-900"
        >
          {/* 背景 */}
          {showBackground && (
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#374151"
            />
          )}

          {/* 控制器 */}
          {showControls && (
            <Controls
              className="!bg-gray-800 !border-gray-700 !shadow-lg"
              showInteractive={false}
            />
          )}

          {/* 小地图 */}
          {showMiniMap && (
            <MiniMap
              nodeColor={miniMapNodeColor}
              maskColor="rgba(17, 24, 39, 0.8)"
              className="!bg-gray-800 !border-gray-700"
              pannable
              zoomable
            />
          )}

          {/* 状态面板 */}
          <Panel position="top-left" className="!m-2">
            <DAGStatusPanel dagState={dagState} />
          </Panel>

          {/* 统计面板 */}
          <Panel position="top-right" className="!m-2">
            <DAGStatisticsPanel dagState={dagState} />
          </Panel>
        </ReactFlow>
      </div>

      {/* 详情面板 */}
      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={handleCloseDetail} />
      )}
    </div>
  );
});

DAGViewer.displayName = 'DAGViewer';

/**
 * DAG 状态面板
 */
const DAGStatusPanel = memo(({ dagState }: { dagState: DAGVisualizationState }) => {
  const { name, description, status, startedAt, completedAt, error } = dagState;

  const elapsedTime = useMemo(() => {
    if (startedAt) {
      const end = completedAt || Date.now();
      return end - startedAt;
    }
    return null;
  }, [startedAt, completedAt]);

  const statusColors: Record<DAGStatus, string> = {
    idle: 'bg-gray-600',
    running: 'bg-blue-500 animate-pulse',
    paused: 'bg-yellow-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    cancelled: 'bg-gray-500',
  };

  return (
    <div className="bg-gray-800/90 backdrop-blur rounded-lg p-3 border border-gray-700 shadow-lg min-w-[200px]">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />
        <h3 className="font-semibold text-gray-200">{name}</h3>
      </div>
      {description && (
        <p className="text-xs text-gray-400 mb-2 line-clamp-2">{description}</p>
      )}
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500 uppercase">{status}</span>
        {elapsedTime !== null && (
          <span className="text-gray-400">⏱ {formatDuration(elapsedTime)}</span>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-400 line-clamp-2">⚠ {error}</p>
      )}
    </div>
  );
});

DAGStatusPanel.displayName = 'DAGStatusPanel';

/**
 * DAG 统计面板
 */
const DAGStatisticsPanel = memo(({ dagState }: { dagState: DAGVisualizationState }) => {
  const { statistics } = dagState;
  const progress = calculateProgress(statistics);

  return (
    <div className="bg-gray-800/90 backdrop-blur rounded-lg p-3 border border-gray-700 shadow-lg min-w-[180px]">
      {/* 进度条 */}
      <div className="mb-3">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-400">Progress</span>
          <span className="text-gray-300">{progress}%</span>
        </div>
        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* 任务统计 */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <StatItem label="Total" value={statistics.totalTasks} />
        <StatItem label="Running" value={statistics.runningTasks} color="text-blue-400" />
        <StatItem label="Completed" value={statistics.completedTasks} color="text-green-400" />
        <StatItem label="Failed" value={statistics.failedTasks} color="text-red-400" />
        <StatItem label="Ready" value={statistics.readyTasks} color="text-yellow-400" />
        <StatItem label="Pending" value={statistics.pendingTasks} color="text-gray-400" />
      </div>

      {/* 成本 */}
      {statistics.totalCost > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700 flex justify-between text-xs">
          <span className="text-gray-500">Total Cost</span>
          <span className="text-gray-300">{formatCost(statistics.totalCost)}</span>
        </div>
      )}
    </div>
  );
});

DAGStatisticsPanel.displayName = 'DAGStatisticsPanel';

/**
 * 统计项组件
 */
const StatItem = memo(({
  label,
  value,
  color = 'text-gray-300',
}: {
  label: string;
  value: number;
  color?: string;
}) => (
  <div className="flex justify-between">
    <span className="text-gray-500">{label}</span>
    <span className={color}>{value}</span>
  </div>
));

StatItem.displayName = 'StatItem';

export default DAGViewer;
