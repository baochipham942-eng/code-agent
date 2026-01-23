// ============================================================================
// AgentTaskProgress - Agent 任务进度指示器
// 显示在消息气泡底部，提供长时任务的进度反馈
// ============================================================================

import React from 'react';
import { Loader2, Sparkles, Wrench, PenLine, CheckCircle2, XCircle } from 'lucide-react';
import type { AgentTaskPhase, TaskProgressData } from '@shared/types';

// ============================================================================
// 类型定义
// ============================================================================

interface AgentTaskProgressProps {
  progress: TaskProgressData;
  className?: string;
}

// ============================================================================
// 阶段配置
// ============================================================================

const phaseConfig: Record<AgentTaskPhase, {
  icon: React.ReactNode;
  label: string;
  color: string;
  bgColor: string;
}> = {
  thinking: {
    icon: <Sparkles className="w-3.5 h-3.5" />,
    label: '思考中',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20',
  },
  tool_pending: {
    icon: <Wrench className="w-3.5 h-3.5" />,
    label: '准备执行',
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/20',
  },
  tool_running: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    label: '执行中',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
  },
  generating: {
    icon: <PenLine className="w-3.5 h-3.5" />,
    label: '生成中',
    color: 'text-green-400',
    bgColor: 'bg-green-500/20',
  },
  completed: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    label: '完成',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
  },
  failed: {
    icon: <XCircle className="w-3.5 h-3.5" />,
    label: '失败',
    color: 'text-red-400',
    bgColor: 'bg-red-500/20',
  },
};

// ============================================================================
// 主组件
// ============================================================================

export const AgentTaskProgress: React.FC<AgentTaskProgressProps> = ({
  progress,
  className = '',
}) => {
  const config = phaseConfig[progress.phase];
  const hasProgress = progress.progress !== undefined && progress.phase === 'tool_running';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* 图标和状态 */}
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${config.bgColor}`}>
        <span className={config.color}>{config.icon}</span>
        <span className={`text-xs font-medium ${config.color}`}>
          {progress.step || config.label}
        </span>
      </div>

      {/* 进度条（仅工具执行时显示） */}
      {hasProgress && (
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-300"
              style={{ width: `${progress.progress}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500">
            {progress.toolIndex !== undefined && progress.toolTotal
              ? `${progress.toolIndex + 1}/${progress.toolTotal}`
              : `${Math.round(progress.progress || 0)}%`}
          </span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 紧凑版本（用于消息内联显示）
// ============================================================================

interface CompactProgressProps {
  progress: TaskProgressData;
}

export const CompactTaskProgress: React.FC<CompactProgressProps> = ({ progress }) => {
  const config = phaseConfig[progress.phase];

  // 完成状态不显示
  if (progress.phase === 'completed') {
    return null;
  }

  return (
    <div className="inline-flex items-center gap-1 text-xs">
      <span className={`${config.color} animate-pulse`}>{config.icon}</span>
      <span className="text-zinc-500">
        {progress.step || config.label}
        {progress.progress !== undefined && ` (${Math.round(progress.progress)}%)`}
      </span>
    </div>
  );
};

export default AgentTaskProgress;
