// ============================================================================
// TaskDetailPanel - 任务详情侧边面板
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo, useMemo } from 'react';
import type { TaskNodeData } from '../../../../shared/types/dagVisualization';
import {
  TASK_STATUS_COLORS,
  TASK_TYPE_ICONS,
  formatDuration,
  formatCost,
} from '../../../../shared/types/dagVisualization';

interface TaskDetailPanelProps {
  task: TaskNodeData | null;
  onClose: () => void;
}

/**
 * 任务详情面板
 */
export const TaskDetailPanel = memo(({ task, onClose }: TaskDetailPanelProps) => {
  if (!task) return null;

  const colors = TASK_STATUS_COLORS[task.status];
  const typeIcon = TASK_TYPE_ICONS[task.type];

  // 计算实际耗时
  const actualDuration = useMemo(() => {
    if (task.duration) return task.duration;
    if (task.startedAt && task.completedAt) {
      return task.completedAt - task.startedAt;
    }
    if (task.startedAt) {
      return Date.now() - task.startedAt;
    }
    return null;
  }, [task.duration, task.startedAt, task.completedAt]);

  return (
    <div className="w-80 h-full bg-gray-900 border-l border-gray-700 flex flex-col">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: colors.border, backgroundColor: colors.bg }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xl">{typeIcon}</span>
          <span className="font-semibold truncate" style={{ color: colors.text }}>
            {task.name}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-gray-700/50 transition-colors"
        >
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 基本信息 */}
        <Section title="Basic Info">
          <InfoRow label="Task ID" value={task.taskId} mono />
          <InfoRow label="Type" value={task.type} />
          <InfoRow label="Status" value={task.status} />
          <InfoRow label="Priority" value={task.priority} />
          {task.role && <InfoRow label="Role" value={task.role} />}
        </Section>

        {/* 描述 */}
        {task.description && (
          <Section title="Description">
            <p className="text-sm text-gray-300 whitespace-pre-wrap">{task.description}</p>
          </Section>
        )}

        {/* 时间信息 */}
        <Section title="Timing">
          {task.startedAt && (
            <InfoRow label="Started" value={new Date(task.startedAt).toLocaleString()} />
          )}
          {task.completedAt && (
            <InfoRow label="Completed" value={new Date(task.completedAt).toLocaleString()} />
          )}
          {actualDuration !== null && (
            <InfoRow label="Duration" value={formatDuration(actualDuration)} />
          )}
          {task.estimatedDuration && (
            <InfoRow label="Estimated" value={formatDuration(task.estimatedDuration)} />
          )}
        </Section>

        {/* 执行信息 */}
        <Section title="Execution">
          {task.iterations !== undefined && (
            <InfoRow label="Iterations" value={task.iterations.toString()} />
          )}
          {task.retryCount > 0 && (
            <InfoRow label="Retries" value={task.retryCount.toString()} />
          )}
          {task.cost !== undefined && task.cost > 0 && (
            <InfoRow label="Cost" value={formatCost(task.cost)} />
          )}
        </Section>

        {/* 使用的工具 */}
        {task.toolsUsed && task.toolsUsed.length > 0 && (
          <Section title="Tools Used">
            <div className="flex flex-wrap gap-1.5">
              {task.toolsUsed.map((tool) => (
                <span
                  key={tool}
                  className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded"
                >
                  {tool}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* 输出 */}
        {task.output && (
          <Section title="Output">
            {task.output.text && (
              <div className="mb-2">
                <p className="text-sm text-gray-300 whitespace-pre-wrap line-clamp-10">
                  {task.output.text}
                </p>
                {task.output.text.length > 500 && (
                  <button className="text-xs text-blue-400 hover:underline mt-1">
                    Show more...
                  </button>
                )}
              </div>
            )}
            {task.output.files && task.output.files.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-gray-500">Generated files:</p>
                {task.output.files.map((file, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2 py-1 bg-gray-800 rounded text-xs"
                  >
                    <span>{file.type === 'image' ? '🖼' : file.type === 'data' ? '📊' : '📄'}</span>
                    <span className="text-gray-300 truncate">{file.path}</span>
                  </div>
                ))}
              </div>
            )}
            {task.output.data && Object.keys(task.output.data).length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">Data:</p>
                <pre className="text-xs bg-gray-800 p-2 rounded overflow-x-auto">
                  {JSON.stringify(task.output.data, null, 2)}
                </pre>
              </div>
            )}
          </Section>
        )}

        {/* 错误信息 */}
        {task.failure && (
          <Section title="Error" variant="error">
            <div className="space-y-2">
              <p className="text-sm text-red-300">{task.failure.message}</p>
              {task.failure.code && (
                <InfoRow label="Code" value={task.failure.code} />
              )}
              {task.failure.stack && (
                <details className="mt-2">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">
                    Stack trace
                  </summary>
                  <pre className="text-xs bg-gray-800 p-2 rounded mt-1 overflow-x-auto text-red-300">
                    {task.failure.stack}
                  </pre>
                </details>
              )}
              {task.failure.retryable && (
                <p className="text-xs text-yellow-400">⚠ This error is retryable</p>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
});

TaskDetailPanel.displayName = 'TaskDetailPanel';

/**
 * 区块组件
 */
const Section = memo(({
  title,
  children,
  variant = 'default',
}: {
  title: string;
  children: React.ReactNode;
  variant?: 'default' | 'error';
}) => (
  <div
    className={`rounded-lg p-3 ${
      variant === 'error' ? 'bg-red-900/20 border border-red-800' : 'bg-gray-800'
    }`}
  >
    <h3
      className={`text-xs font-semibold uppercase mb-2 ${
        variant === 'error' ? 'text-red-400' : 'text-gray-500'
      }`}
    >
      {title}
    </h3>
    {children}
  </div>
));

Section.displayName = 'Section';

/**
 * 信息行组件
 */
const InfoRow = memo(({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) => (
  <div className="flex justify-between items-center py-1">
    <span className="text-xs text-gray-500">{label}</span>
    <span className={`text-sm text-gray-300 ${mono ? 'font-mono text-xs' : ''}`}>
      {value}
    </span>
  </div>
));

InfoRow.displayName = 'InfoRow';

export default TaskDetailPanel;
