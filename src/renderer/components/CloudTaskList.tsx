// ============================================================================
// CloudTaskList - 云端任务列表组件
// 显示和管理云端执行的任务
// ============================================================================

import React, { useState } from 'react';
import { UI } from '@shared/constants';
import {
  Cloud,
  Monitor,
  GitBranch,
  Play,
  Pause,
  X,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  FileText,
  Code,
  BookOpen,
  Target,
  Users,
} from 'lucide-react';
import { TaskProgress } from './TaskProgress';
import type {
  CloudTask,
  CloudAgentType,
  CloudTaskStatus,
  TaskExecutionLocation,
} from '@shared/types/cloud';

// ============================================================================
// 类型定义
// ============================================================================

interface CloudTaskListProps {
  tasks: CloudTask[];
  onStartTask?: (taskId: string) => void;
  onPauseTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onRetryTask?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
}

// ============================================================================
// 辅助组件
// ============================================================================

// 状态图标
const StatusIcon: React.FC<{ status: CloudTaskStatus }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-400" />;
    case 'running':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case 'queued':
      return <Clock className="w-4 h-4 text-yellow-400" />;
    case 'paused':
      return <Pause className="w-4 h-4 text-orange-400" />;
    case 'cancelled':
      return <X className="w-4 h-4 text-zinc-500" />;
    default:
      return <Clock className="w-4 h-4 text-zinc-500" />;
  }
};

// 位置图标
const LocationIcon: React.FC<{ location: TaskExecutionLocation }> = ({ location }) => {
  switch (location) {
    case 'cloud':
      return <Cloud className="w-4 h-4 text-sky-400" />;
    case 'local':
      return <Monitor className="w-4 h-4 text-emerald-400" />;
    case 'hybrid':
      return <GitBranch className="w-4 h-4 text-purple-400" />;
  }
};

// Agent 类型图标
const AgentIcon: React.FC<{ type: CloudAgentType }> = ({ type }) => {
  switch (type) {
    case 'researcher':
      return <Search className="w-4 h-4 text-indigo-400" />;
    case 'analyzer':
      return <Code className="w-4 h-4 text-cyan-400" />;
    case 'writer':
      return <FileText className="w-4 h-4 text-amber-400" />;
    case 'reviewer':
      return <BookOpen className="w-4 h-4 text-pink-400" />;
    case 'planner':
      return <Target className="w-4 h-4 text-teal-400" />;
  }
};

// 状态标签
const StatusBadge: React.FC<{ status: CloudTaskStatus }> = ({ status }) => {
  const styles: Record<CloudTaskStatus, string> = {
    pending: 'bg-zinc-700 text-zinc-300',
    queued: 'bg-yellow-900/50 text-yellow-300',
    running: 'bg-blue-900/50 text-blue-300',
    paused: 'bg-orange-900/50 text-orange-300',
    completed: 'bg-green-900/50 text-green-300',
    failed: 'bg-red-900/50 text-red-300',
    cancelled: 'bg-zinc-800 text-zinc-400',
  };

  const labels: Record<CloudTaskStatus, string> = {
    pending: '等待中',
    queued: '已排队',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status]}`}>
      {labels[status]}
    </span>
  );
};

// 单个任务卡片
const TaskCard: React.FC<{
  task: CloudTask;
  onStart?: () => void;
  onPause?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  onDelete?: () => void;
}> = ({ task, onStart, onPause, onCancel, onRetry, onDelete }) => {
  const [expanded, setExpanded] = useState(false);

  const canStart = task.status === 'pending' || task.status === 'paused';
  const canPause = task.status === 'running';
  const canCancel = task.status === 'running' || task.status === 'queued';
  const canRetry = task.status === 'failed';
  const canDelete = ['completed', 'failed', 'cancelled'].includes(task.status);

  const formatTime = (isoString: string | undefined) => {
    if (!isoString) return '-';
    return new Date(isoString).toLocaleTimeString();
  };

  const formatDuration = (start?: string, end?: string) => {
    if (!start) return '-';
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const duration = endTime - startTime;

    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
    return `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`;
  };

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700/50 overflow-hidden">
      {/* 任务头部 */}
      <div
        className="p-3 cursor-pointer hover:bg-zinc-700/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start gap-3">
          {/* 展开图标 */}
          <button className="mt-1 text-zinc-500">
            {expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>

          {/* 状态图标 */}
          <div className="mt-0.5">
            <StatusIcon status={task.status} />
          </div>

          {/* 任务信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <AgentIcon type={task.type} />
              <span className="text-sm font-medium text-zinc-200 truncate">
                {task.title}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <LocationIcon location={task.location} />
              <span>{task.location}</span>
              <span>•</span>
              <span>{task.type}</span>
              {task.currentStep && (
                <>
                  <span>•</span>
                  <span className="text-zinc-400">{task.currentStep}</span>
                </>
              )}
            </div>

            {/* 进度条 */}
            {(task.status === 'running' || task.status === 'queued') && (
              <div className="mt-2">
                <TaskProgress
                  progress={task.progress}
                  status={task.status}
                  size="sm"
                />
              </div>
            )}
          </div>

          {/* 状态标签 */}
          <div className="flex items-center gap-2">
            <StatusBadge status={task.status} />
          </div>
        </div>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-zinc-700/50 p-3 bg-zinc-900/30">
          {/* 描述 */}
          {task.description && (
            <p className="text-sm text-zinc-400 mb-3">{task.description}</p>
          )}

          {/* 详细信息 */}
          <div className="grid grid-cols-2 gap-2 text-xs mb-3">
            <div>
              <span className="text-zinc-500">创建时间：</span>
              <span className="text-zinc-300">{formatTime(task.createdAt)}</span>
            </div>
            <div>
              <span className="text-zinc-500">开始时间：</span>
              <span className="text-zinc-300">{formatTime(task.startedAt)}</span>
            </div>
            <div>
              <span className="text-zinc-500">完成时间：</span>
              <span className="text-zinc-300">{formatTime(task.completedAt)}</span>
            </div>
            <div>
              <span className="text-zinc-500">耗时：</span>
              <span className="text-zinc-300">
                {formatDuration(task.startedAt, task.completedAt)}
              </span>
            </div>
          </div>

          {/* 错误信息 */}
          {task.error && (
            <div className="mb-3 p-2 bg-red-900/20 border border-red-500/30 rounded text-xs text-red-300">
              {task.error}
            </div>
          )}

          {/* 结果预览 */}
          {task.result && (
            <div className="mb-3 p-2 bg-zinc-800 rounded text-xs text-zinc-300 max-h-32 overflow-y-auto">
              <pre className="whitespace-pre-wrap">{task.result.slice(0, UI.PREVIEW_TEXT_MAX_LENGTH)}</pre>
              {task.result.length > UI.PREVIEW_TEXT_MAX_LENGTH && (
                <span className="text-zinc-500">... ({task.result.length - UI.PREVIEW_TEXT_MAX_LENGTH} more chars)</span>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2">
            {canStart && (
              <button
                onClick={(e) => { e.stopPropagation(); onStart?.(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
              >
                <Play className="w-3 h-3" />
                开始
              </button>
            )}
            {canPause && (
              <button
                onClick={(e) => { e.stopPropagation(); onPause?.(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
              >
                <Pause className="w-3 h-3" />
                暂停
              </button>
            )}
            {canCancel && (
              <button
                onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              >
                <X className="w-3 h-3" />
                取消
              </button>
            )}
            {canRetry && (
              <button
                onClick={(e) => { e.stopPropagation(); onRetry?.(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                重试
              </button>
            )}
            {canDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-zinc-600 hover:bg-zinc-500 text-white rounded transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// 空状态
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-12 text-center">
    <Cloud className="w-12 h-12 text-zinc-600 mb-3" />
    <p className="text-sm text-zinc-400 mb-1">暂无云端任务</p>
    <p className="text-xs text-zinc-500">
      将任务提交到云端执行后会在这里显示
    </p>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const CloudTaskList: React.FC<CloudTaskListProps> = ({
  tasks,
  onStartTask,
  onPauseTask,
  onCancelTask,
  onRetryTask,
  onDeleteTask,
  onRefresh,
  isLoading = false,
}) => {
  const [filter, setFilter] = useState<CloudTaskStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<CloudAgentType | 'all'>('all');

  // 过滤任务
  const filteredTasks = tasks.filter((task) => {
    if (filter !== 'all' && task.status !== filter) return false;
    if (typeFilter !== 'all' && task.type !== typeFilter) return false;
    return true;
  });

  // 统计
  const stats = {
    total: tasks.length,
    running: tasks.filter((t) => t.status === 'running').length,
    queued: tasks.filter((t) => t.status === 'queued').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="p-3 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-zinc-100">云端任务</span>
            <span className="text-xs text-zinc-500">({stats.total})</span>
          </div>

          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* 统计 */}
        <div className="flex gap-3 text-xs">
          <span className="text-blue-400">{stats.running} 执行中</span>
          <span className="text-yellow-400">{stats.queued} 排队中</span>
          <span className="text-green-400">{stats.completed} 已完成</span>
          <span className="text-red-400">{stats.failed} 失败</span>
        </div>

        {/* 过滤器 */}
        <div className="flex gap-2 mt-3">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as CloudTaskStatus | 'all')}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
          >
            <option value="all">全部状态</option>
            <option value="running">执行中</option>
            <option value="queued">排队中</option>
            <option value="pending">等待中</option>
            <option value="completed">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as CloudAgentType | 'all')}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
          >
            <option value="all">全部类型</option>
            <option value="researcher">研究员</option>
            <option value="analyzer">分析师</option>
            <option value="writer">写作者</option>
            <option value="reviewer">审查员</option>
            <option value="planner">规划师</option>
          </select>
        </div>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto p-2">
        {filteredTasks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onStart={() => onStartTask?.(task.id)}
                onPause={() => onPauseTask?.(task.id)}
                onCancel={() => onCancelTask?.(task.id)}
                onRetry={() => onRetryTask?.(task.id)}
                onDelete={() => onDeleteTask?.(task.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
