// ============================================================================
// TaskNode - 自定义 React Flow 任务节点
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo, useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TaskStatus } from '../../../../shared/types/taskDAG';
import {
  type TaskNodeData,
  TASK_STATUS_COLORS,
  TASK_TYPE_ICONS,
  PRIORITY_BADGE_COLORS,
  formatDuration,
  formatCost,
  getStatusAnimationClass,
} from '../../../../shared/types/dagVisualization';

// Re-export for use by other files
export type { TaskNodeData };

interface TaskNodeProps {
  data: TaskNodeData;
  selected?: boolean;
}

/**
 * 任务节点组件
 */
export const TaskNode = memo(({ data, selected }: TaskNodeProps) => {
  const {
    name,
    description,
    type,
    status,
    priority,
    role,
    startedAt,
    completedAt,
    duration,
    estimatedDuration,
    retryCount,
    cost,
    toolsUsed,
    iterations,
    failure,
    isHighlighted,
  } = data;

  // 获取状态颜色
  const colors = TASK_STATUS_COLORS[status];
  const typeIcon = TASK_TYPE_ICONS[type];
  const priorityColor = PRIORITY_BADGE_COLORS[priority];
  const animationClass = getStatusAnimationClass(status);

  // 计算运行时间
  const elapsedTime = useMemo(() => {
    if (duration) return duration;
    if (startedAt && !completedAt) {
      return Date.now() - startedAt;
    }
    return null;
  }, [duration, startedAt, completedAt]);

  // 构建状态文字
  const statusText = useMemo(() => {
    switch (status) {
      case 'pending':
        return 'Waiting...';
      case 'ready':
        return 'Ready';
      case 'running':
        return iterations ? `Running (${iterations} iterations)` : 'Running...';
      case 'completed':
        return 'Completed';
      case 'failed':
        return failure?.message ? `Failed: ${failure.message.slice(0, 30)}...` : 'Failed';
      case 'cancelled':
        return 'Cancelled';
      case 'skipped':
        return 'Skipped';
      default:
        return status;
    }
  }, [status, iterations, failure]);

  return (
    <div
      className={`
        relative min-w-[200px] max-w-[280px] rounded-lg border-2 shadow-lg
        transition-all duration-200 ease-in-out
        ${animationClass}
        ${selected ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-gray-900' : ''}
        ${isHighlighted ? 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-gray-900' : ''}
      `}
      style={{
        backgroundColor: colors.bg,
        borderColor: colors.border,
      }}
    >
      {/* 输入 Handle */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-gray-400 !border-2 !border-gray-600"
      />

      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-600/50">
        {/* 类型图标和名称 */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg" title={type}>
            {typeIcon}
          </span>
          <span
            className="font-medium truncate"
            style={{ color: colors.text }}
            title={name}
          >
            {name}
          </span>
        </div>

        {/* 优先级徽章 */}
        {priority !== 'normal' && (
          <span
            className="px-1.5 py-0.5 text-xs font-medium rounded uppercase"
            style={{ backgroundColor: priorityColor, color: '#FFFFFF' }}
          >
            {priority}
          </span>
        )}
      </div>

      {/* 内容区 */}
      <div className="px-3 py-2 space-y-2">
        {/* 角色（Agent 类型） */}
        {role && (
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <span>Role:</span>
            <span className="font-medium text-gray-300">{role}</span>
          </div>
        )}

        {/* 描述 */}
        {description && (
          <p
            className="text-xs text-gray-400 line-clamp-2"
            title={description}
          >
            {description}
          </p>
        )}

        {/* 状态 */}
        <div className="flex items-center gap-2">
          <StatusIndicator status={status} />
          <span className="text-xs" style={{ color: colors.text }}>
            {statusText}
          </span>
        </div>

        {/* 时间和成本 */}
        <div className="flex items-center justify-between text-xs text-gray-400">
          {elapsedTime !== null && (
            <span>
              ⏱ {formatDuration(elapsedTime)}
              {estimatedDuration && status === 'running' && (
                <span className="text-gray-500"> / {formatDuration(estimatedDuration)}</span>
              )}
            </span>
          )}
          {cost !== undefined && cost > 0 && (
            <span>💰 {formatCost(cost)}</span>
          )}
        </div>

        {/* 工具使用 */}
        {toolsUsed && toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {toolsUsed.slice(0, 3).map((tool: string) => (
              <span
                key={tool}
                className="px-1.5 py-0.5 text-[10px] bg-gray-700 text-gray-300 rounded"
              >
                {tool}
              </span>
            ))}
            {toolsUsed.length > 3 && (
              <span className="px-1.5 py-0.5 text-[10px] bg-gray-700 text-gray-400 rounded">
                +{toolsUsed.length - 3}
              </span>
            )}
          </div>
        )}

        {/* 重试次数 */}
        {retryCount > 0 && (
          <div className="text-xs text-yellow-400">
            🔄 Retry #{retryCount}
          </div>
        )}
      </div>

      {/* 输出 Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-gray-400 !border-2 !border-gray-600"
      />

      {/* 运行中的动画边框 */}
      {status === 'running' && (
        <div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{
            background: `linear-gradient(90deg, transparent, ${colors.border}40, transparent)`,
            animation: 'shimmer 2s infinite',
          }}
        />
      )}
    </div>
  );
});

TaskNode.displayName = 'TaskNode';

/**
 * 状态指示器
 */
const StatusIndicator = memo(({ status }: { status: TaskStatus }) => {
  const indicators: Record<TaskStatus, React.ReactNode> = {
    pending: <div className="w-2 h-2 rounded-full bg-gray-400" />,
    ready: <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />,
    running: (
      <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
    ),
    completed: (
      <svg className="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
    ),
    failed: (
      <svg className="w-3 h-3 text-red-400" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
          clipRule="evenodd"
        />
      </svg>
    ),
    cancelled: (
      <svg className="w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
          clipRule="evenodd"
        />
      </svg>
    ),
    skipped: (
      <svg className="w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
        <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
        <path
          fillRule="evenodd"
          d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z"
          clipRule="evenodd"
        />
      </svg>
    ),
  };

  return <div className="flex items-center justify-center">{indicators[status]}</div>;
});

StatusIndicator.displayName = 'StatusIndicator';

export default TaskNode;
