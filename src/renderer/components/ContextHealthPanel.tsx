// ============================================================================
// ContextHealthPanel - 上下文健康度指示器
// 显示当前会话的 token 使用情况
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Activity, AlertTriangle, AlertCircle, Sparkles } from 'lucide-react';
import type { ContextHealthState, ContextHealthWarningLevel } from '@shared/types/contextHealth';

interface ContextHealthPanelProps {
  health: ContextHealthState | null;
  collapsed?: boolean;
  onToggle?: () => void;
}

/**
 * 格式化 token 数量（添加千分位分隔符）
 */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

/**
 * 获取警告级别对应的颜色配置
 */
function getWarningColors(level: ContextHealthWarningLevel) {
  switch (level) {
    case 'critical':
      return {
        icon: AlertCircle,
        iconColor: 'text-red-400',
        barColor: 'bg-red-500',
        bgColor: 'bg-red-500/10',
        textColor: 'text-red-400',
      };
    case 'warning':
      return {
        icon: AlertTriangle,
        iconColor: 'text-yellow-400',
        barColor: 'bg-yellow-500',
        bgColor: 'bg-yellow-500/10',
        textColor: 'text-yellow-400',
      };
    default:
      return {
        icon: Activity,
        iconColor: 'text-emerald-400',
        barColor: 'bg-emerald-500',
        bgColor: '',
        textColor: 'text-zinc-400',
      };
  }
}

export const ContextHealthPanel: React.FC<ContextHealthPanelProps> = ({
  health,
  collapsed = true,
  onToggle,
}) => {
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  const [showBreakdown, setShowBreakdown] = useState(false);

  // 如果没有健康数据，不渲染
  if (!health) {
    return null;
  }

  const colors = getWarningColors(health.warningLevel);
  const IconComponent = colors.icon;

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    onToggle?.();
  };

  return (
    <div className={`border-b border-zinc-800 ${colors.bgColor}`}>
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 p-3 hover:bg-zinc-800/50 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        )}
        <IconComponent className={`w-4 h-4 ${colors.iconColor}`} />
        <span className="text-sm font-medium text-zinc-100">上下文健康度</span>
        <span className={`ml-auto text-sm font-mono ${colors.textColor}`}>
          {health.usagePercent.toFixed(1)}%
        </span>
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* 进度条 */}
          <div className="space-y-1.5">
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full ${colors.barColor} transition-all duration-300`}
                style={{ width: `${Math.min(health.usagePercent, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400 font-mono">
                {formatTokens(health.currentTokens)} / {formatTokens(health.maxTokens)} tokens
              </span>
            </div>
          </div>

          {/* 分解详情 - 可展开 */}
          <div>
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {showBreakdown ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <span>Token 分解</span>
            </button>

            {showBreakdown && (
              <div className="mt-2 space-y-1.5 pl-4">
                <BreakdownItem
                  label="System Prompt"
                  tokens={health.breakdown.systemPrompt}
                  total={health.currentTokens}
                />
                <BreakdownItem
                  label="Messages"
                  tokens={health.breakdown.messages}
                  total={health.currentTokens}
                />
                <BreakdownItem
                  label="Tool Results"
                  tokens={health.breakdown.toolResults}
                  total={health.currentTokens}
                />
              </div>
            )}
          </div>

          {/* 预估剩余轮数 */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Sparkles className="w-3 h-3" />
            <span>
              预估剩余:{' '}
              <span className="text-zinc-300">~{health.estimatedTurnsRemaining} 轮</span>
            </span>
          </div>

          {/* 警告提示 */}
          {health.warningLevel === 'critical' && (
            <div className="flex items-center gap-2 p-2 bg-red-500/20 rounded-md">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span className="text-xs text-red-300">
                上下文即将耗尽，建议开启新会话或压缩上下文
              </span>
            </div>
          )}

          {health.warningLevel === 'warning' && (
            <div className="flex items-center gap-2 p-2 bg-yellow-500/20 rounded-md">
              <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
              <span className="text-xs text-yellow-300">
                上下文使用率较高，请注意控制对话长度
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Token 分解项
 */
const BreakdownItem: React.FC<{
  label: string;
  tokens: number;
  total: number;
}> = ({ label, tokens, total }) => {
  const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : '0.0';

  return (
    <div className="flex justify-between text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-400 font-mono">
        {formatTokens(tokens)} ({percent}%)
      </span>
    </div>
  );
};

export default ContextHealthPanel;
