// ============================================================================
// ContextUsageIndicator - 上下文使用量圆环指示器
// 显示 token 使用量百分比，支持警告和危险状态
// ============================================================================

import React, { useMemo } from 'react';

// ============================================================================
// 类型定义
// ============================================================================

export type ContextUsageSize = 'sm' | 'md' | 'lg';

export interface ContextUsageIndicatorProps {
  /** 已使用 token 数 */
  used: number;
  /** 总 token 数 */
  total: number;
  /** 是否显示数值 */
  showValue?: boolean;
  /** 尺寸 */
  size?: ContextUsageSize;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 常量配置
// ============================================================================

const SIZE_CONFIG = {
  sm: {
    width: 24,
    height: 24,
    strokeWidth: 3,
    fontSize: 'text-2xs',
    valueSize: 'text-3xs',
  },
  md: {
    width: 32,
    height: 32,
    strokeWidth: 4,
    fontSize: 'text-xs',
    valueSize: 'text-2xs',
  },
  lg: {
    width: 48,
    height: 48,
    strokeWidth: 5,
    fontSize: 'text-sm',
    valueSize: 'text-xs',
  },
} as const;

const THRESHOLDS = {
  warning: 0.7,  // 70% 警告状态
  danger: 0.9,   // 90% 危险状态
} as const;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 根据使用百分比获取状态颜色
 */
function getStatusColors(percentage: number): {
  stroke: string;
  bg: string;
  text: string;
  glow: string;
} {
  if (percentage >= THRESHOLDS.danger) {
    return {
      stroke: 'stroke-red-500',
      bg: 'stroke-red-500/20',
      text: 'text-red-400',
      glow: 'drop-shadow-[0_0_4px_rgba(239,68,68,0.5)]',
    };
  }
  if (percentage >= THRESHOLDS.warning) {
    return {
      stroke: 'stroke-amber-500',
      bg: 'stroke-amber-500/20',
      text: 'text-amber-400',
      glow: 'drop-shadow-[0_0_4px_rgba(245,158,11,0.4)]',
    };
  }
  return {
    stroke: 'stroke-primary-500',
    bg: 'stroke-primary-500/20',
    text: 'text-primary-400',
    glow: '',
  };
}

/**
 * 格式化 token 数值
 */
function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

// ============================================================================
// 主组件
// ============================================================================

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  used,
  total,
  showValue = false,
  size = 'md',
  className = '',
}) => {
  // 计算百分比和配置
  const { percentage, displayPercentage, circumference, dashOffset, config, colors } = useMemo(() => {
    const pct = total > 0 ? Math.min(used / total, 1) : 0;
    const cfg = SIZE_CONFIG[size];
    const radius = (cfg.width - cfg.strokeWidth) / 2;
    const circ = 2 * Math.PI * radius;
    const offset = circ * (1 - pct);

    return {
      percentage: pct,
      displayPercentage: Math.round(pct * 100),
      circumference: circ,
      dashOffset: offset,
      config: cfg,
      colors: getStatusColors(pct),
    };
  }, [used, total, size]);

  const { width, height, strokeWidth } = config;
  const radius = (width - strokeWidth) / 2;
  const center = width / 2;

  return (
    <div
      className={`inline-flex items-center gap-2 ${className}`}
      title={`${formatTokenCount(used)} / ${formatTokenCount(total)} tokens (${displayPercentage}%)`}
    >
      {/* SVG 圆环 */}
      <div className="relative">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={`transform -rotate-90 transition-all duration-500 ${colors.glow}`}
        >
          {/* 背景圆环 */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className={`${colors.bg} transition-colors duration-300`}
          />
          {/* 进度圆环 */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={`${colors.stroke} transition-all duration-500 ease-out`}
            style={{
              // 确保动画平滑
              transitionProperty: 'stroke-dashoffset, stroke',
            }}
          />
        </svg>

        {/* 中心百分比文字（仅 lg 尺寸） */}
        {size === 'lg' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`${config.valueSize} font-medium ${colors.text} transition-colors duration-300`}>
              {displayPercentage}%
            </span>
          </div>
        )}
      </div>

      {/* 数值显示 */}
      {showValue && (
        <div className="flex flex-col">
          <span className={`${config.fontSize} font-medium ${colors.text} transition-colors duration-300`}>
            {displayPercentage}%
          </span>
          <span className="text-2xs text-zinc-500">
            {formatTokenCount(used)} / {formatTokenCount(total)}
          </span>
        </div>
      )}
    </div>
  );
};

export default ContextUsageIndicator;
