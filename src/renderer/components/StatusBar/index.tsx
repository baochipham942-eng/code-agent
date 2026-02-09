// ============================================================================
// StatusBar - 底部状态栏主组件
// ============================================================================
// 显示：模型 | 消息数 | Token | 费用 | 上下文 | 时长 | 网络 | Git
// 参考 Claude Code 设计：固定底部，高度 28px，font-mono

import React from 'react';
import { useStatusStore } from '../../stores/statusStore';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { ModelIndicator } from './ModelIndicator';
import { ModelSwitcher } from './ModelSwitcher';
import { MessageCounter } from './MessageCounter';
import { TokenUsage } from './TokenUsage';
import { CostDisplay } from './CostDisplay';
import { ContextUsage } from './ContextUsage';
import { SessionDuration } from './SessionDuration';
import { NetworkStatus } from './NetworkStatus';
import { GitInfo } from './GitInfo';

/**
 * 分隔符组件
 */
function Separator() {
  return <span className="text-gray-600">|</span>;
}

export function StatusBar() {
  const { modelConfig, disclosureLevel } = useAppStore();
  const messages = useSessionStore((state) => state.messages);
  const {
    inputTokens,
    outputTokens,
    sessionCost,
    contextUsagePercent,
    sessionStartTime,
    networkStatus,
    isStreaming,
  } = useStatusStore();

  // 渐进披露：simple 模式不显示状态栏
  if (disclosureLevel === 'simple') {
    return null;
  }

  return (
    <div
      className="
        fixed bottom-0 left-0 right-0
        h-7 px-3
        bg-zinc-900/95 backdrop-blur-sm
        border-t border-zinc-700/50
        flex items-center justify-between
        text-xs text-gray-400
        font-mono
        z-50
      "
    >
      {/* 左侧区域：模型、消息数、Token */}
      <div className="flex items-center gap-3">
        <ModelSwitcher currentModel={modelConfig.model} />
        <Separator />
        <MessageCounter count={messages.length} />
        <Separator />
        <TokenUsage input={inputTokens} output={outputTokens} isStreaming={isStreaming} />
      </div>

      {/* 中间区域：费用、上下文使用 */}
      <div className="flex items-center gap-3">
        <CostDisplay cost={sessionCost} isStreaming={isStreaming} />
        <Separator />
        <ContextUsage percent={contextUsagePercent} />
      </div>

      {/* 右侧区域：时长、网络、Git */}
      <div className="flex items-center gap-3">
        <SessionDuration startTime={sessionStartTime} />
        <Separator />
        <NetworkStatus status={networkStatus} />
        <Separator />
        <GitInfo />
        {/* Autonomous mode indicator (when active) */}
        {isStreaming && (
          <>
            <Separator />
            <span className="text-amber-400 animate-pulse" title="自主迭代模式">
              AUTO
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// 导出所有子组件，方便单独使用
export { ModelIndicator } from './ModelIndicator';
export { ModelSwitcher } from './ModelSwitcher';
export { MessageCounter } from './MessageCounter';
export { TokenUsage } from './TokenUsage';
export { CostDisplay } from './CostDisplay';
export { ContextUsage } from './ContextUsage';
export { SessionDuration } from './SessionDuration';
export { NetworkStatus } from './NetworkStatus';
export { GitInfo } from './GitInfo';
