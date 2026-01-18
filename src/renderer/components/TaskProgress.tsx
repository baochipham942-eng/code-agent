// ============================================================================
// TaskProgress - 任务进度条组件
// 显示任务执行进度，支持多种样式
// ============================================================================

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { CloudTaskStatus } from '@shared/types/cloud';

// ============================================================================
// 类型定义
// ============================================================================

interface TaskProgressProps {
  progress: number; // 0-100
  status: CloudTaskStatus;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  showPercentage?: boolean;
  animated?: boolean;
  className?: string;
}

// ============================================================================
// 样式配置
// ============================================================================

const sizeStyles = {
  sm: {
    bar: 'h-1',
    label: 'text-xs',
    icon: 'w-3 h-3',
  },
  md: {
    bar: 'h-2',
    label: 'text-sm',
    icon: 'w-4 h-4',
  },
  lg: {
    bar: 'h-3',
    label: 'text-base',
    icon: 'w-5 h-5',
  },
};

const statusColors: Record<CloudTaskStatus, { bg: string; fill: string; text: string }> = {
  pending: {
    bg: 'bg-zinc-700',
    fill: 'bg-zinc-500',
    text: 'text-zinc-400',
  },
  queued: {
    bg: 'bg-yellow-900/30',
    fill: 'bg-yellow-500',
    text: 'text-yellow-400',
  },
  running: {
    bg: 'bg-blue-900/30',
    fill: 'bg-blue-500',
    text: 'text-blue-400',
  },
  paused: {
    bg: 'bg-orange-900/30',
    fill: 'bg-orange-500',
    text: 'text-orange-400',
  },
  completed: {
    bg: 'bg-green-900/30',
    fill: 'bg-green-500',
    text: 'text-green-400',
  },
  failed: {
    bg: 'bg-red-900/30',
    fill: 'bg-red-500',
    text: 'text-red-400',
  },
  cancelled: {
    bg: 'bg-zinc-800',
    fill: 'bg-zinc-600',
    text: 'text-zinc-500',
  },
};

const statusLabels: Record<CloudTaskStatus, string> = {
  pending: '等待中',
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

// ============================================================================
// 主组件
// ============================================================================

export const TaskProgress: React.FC<TaskProgressProps> = ({
  progress,
  status,
  size = 'md',
  showLabel = false,
  showPercentage = false,
  animated = true,
  className = '',
}) => {
  const sizeStyle = sizeStyles[size];
  const colorStyle = statusColors[status];
  const clampedProgress = Math.max(0, Math.min(100, progress));

  // 是否显示动画
  const isAnimating = animated && status === 'running';

  return (
    <div className={`w-full ${className}`}>
      {/* 标签行 */}
      {(showLabel || showPercentage) && (
        <div className="flex items-center justify-between mb-1">
          {showLabel && (
            <div className="flex items-center gap-1">
              {status === 'running' && (
                <Loader2 className={`${sizeStyle.icon} animate-spin ${colorStyle.text}`} />
              )}
              <span className={`${sizeStyle.label} ${colorStyle.text}`}>
                {statusLabels[status]}
              </span>
            </div>
          )}
          {showPercentage && (
            <span className={`${sizeStyle.label} ${colorStyle.text}`}>
              {Math.round(clampedProgress)}%
            </span>
          )}
        </div>
      )}

      {/* 进度条 */}
      <div className={`w-full ${sizeStyle.bar} ${colorStyle.bg} rounded-full overflow-hidden`}>
        <div
          className={`
            ${sizeStyle.bar}
            ${colorStyle.fill}
            rounded-full
            transition-all
            duration-300
            ${isAnimating ? 'animate-pulse' : ''}
          `}
          style={{ width: `${clampedProgress}%` }}
        >
          {/* 条纹动画 */}
          {isAnimating && (
            <div
              className="h-full w-full opacity-30"
              style={{
                backgroundImage: `repeating-linear-gradient(
                  -45deg,
                  transparent,
                  transparent 8px,
                  rgba(255,255,255,0.2) 8px,
                  rgba(255,255,255,0.2) 16px
                )`,
                backgroundSize: '32px 100%',
                animation: 'progress-stripes 1s linear infinite',
              }}
            />
          )}
        </div>
      </div>

      {/* 添加条纹动画样式 */}
      <style>{`
        @keyframes progress-stripes {
          from { background-position: 0 0; }
          to { background-position: 32px 0; }
        }
      `}</style>
    </div>
  );
};

// ============================================================================
// 圆形进度组件
// ============================================================================

interface CircularProgressProps {
  progress: number;
  status: CloudTaskStatus;
  size?: number;
  strokeWidth?: number;
  showPercentage?: boolean;
  className?: string;
}

export const CircularProgress: React.FC<CircularProgressProps> = ({
  progress,
  status,
  size = 48,
  strokeWidth = 4,
  showPercentage = true,
  className = '',
}) => {
  const colorStyle = statusColors[status];
  const clampedProgress = Math.max(0, Math.min(100, progress));

  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (clampedProgress / 100) * circumference;

  return (
    <div className={`relative inline-flex items-center justify-center ${className}`}>
      <svg
        className="transform -rotate-90"
        width={size}
        height={size}
      >
        {/* 背景圆 */}
        <circle
          className={colorStyle.bg.replace('bg-', 'stroke-')}
          strokeWidth={strokeWidth}
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        {/* 进度圆 */}
        <circle
          className={`${colorStyle.fill.replace('bg-', 'stroke-')} transition-all duration-300`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: offset,
          }}
        />
      </svg>

      {/* 中心文字 */}
      {showPercentage && (
        <span
          className={`absolute text-xs font-medium ${colorStyle.text}`}
          style={{ fontSize: size * 0.22 }}
        >
          {Math.round(clampedProgress)}%
        </span>
      )}

      {/* 运行中动画 */}
      {status === 'running' && (
        <div
          className="absolute inset-0 rounded-full animate-ping opacity-20"
          style={{
            backgroundColor: colorStyle.fill.replace('bg-', ''),
          }}
        />
      )}
    </div>
  );
};

// ============================================================================
// 步骤进度组件
// ============================================================================

interface StepProgressProps {
  steps: Array<{
    label: string;
    status: 'pending' | 'current' | 'completed' | 'failed';
  }>;
  className?: string;
}

export const StepProgress: React.FC<StepProgressProps> = ({
  steps,
  className = '',
}) => {
  return (
    <div className={`flex items-center ${className}`}>
      {steps.map((step, index) => (
        <React.Fragment key={index}>
          {/* 步骤点 */}
          <div className="flex flex-col items-center">
            <div
              className={`
                w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium
                ${step.status === 'completed' ? 'bg-green-500 text-white' : ''}
                ${step.status === 'current' ? 'bg-blue-500 text-white animate-pulse' : ''}
                ${step.status === 'pending' ? 'bg-zinc-700 text-zinc-400' : ''}
                ${step.status === 'failed' ? 'bg-red-500 text-white' : ''}
              `}
            >
              {step.status === 'completed' ? '✓' : index + 1}
            </div>
            <span className="mt-1 text-xs text-zinc-500">{step.label}</span>
          </div>

          {/* 连接线 */}
          {index < steps.length - 1 && (
            <div
              className={`
                flex-1 h-0.5 mx-2
                ${step.status === 'completed' ? 'bg-green-500' : 'bg-zinc-700'}
              `}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
