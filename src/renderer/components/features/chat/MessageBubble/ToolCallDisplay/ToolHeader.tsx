// ============================================================================
// ToolHeader - Tool name + params + duration (no icon, no LoadingDots)
// Status is expressed by parent StatusIndicator
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { formatParams, formatDuration, getToolDisplayName } from './utils';
import { getToolStatusLabel } from './statusLabels';
import type { ToolStatus } from './styles';
import { isSemanticToolUIEnabled } from '../../../../../utils/featureFlags';

interface Props {
  toolCall: ToolCall;
  status: ToolStatus;
}

export function ToolHeader({ toolCall, status }: Props) {
  // 模型若提供了 shortDescription（产品视角语义标签），优先作为主标题展示，
  // 同时屏蔽 params 副标题以避免语义重复；没有时 fallback 到原有渲染。
  // feature flag 关闭时强制 fallback，便于 A/B 对比。
  const hasShortDesc = isSemanticToolUIEnabled()
    && typeof toolCall.shortDescription === 'string'
    && toolCall.shortDescription.trim().length > 0;
  const displayName = hasShortDesc
    ? toolCall.shortDescription!.trim()
    : getToolDisplayName(toolCall.name);
  const statusLabel = getToolStatusLabel(toolCall, status);
  const params = hasShortDesc ? '' : formatParams(toolCall);
  const duration = toolCall.result?.duration;
  const isSandboxed = (toolCall.name === 'bash' || toolCall.name === 'Bash') &&
    typeof toolCall.result?.output === 'string' &&
    toolCall.result.output.includes('[codex-sandbox]');

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {/* Status label - dynamic per-tool text */}
      <span className="text-zinc-500 text-xs flex-shrink-0">{statusLabel}</span>

      {/* Tool name - always semibold, neutral color */}
      {/* truncate + min-w-0 让长 shortDescription（如完整 Bash 命令）按 CSS 截断而不撑爆 layout */}
      <span className="text-zinc-200 font-semibold truncate min-w-0">{displayName}</span>

      {/* Sandbox badge */}
      {isSandboxed && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
          sandbox
        </span>
      )}

      {/* Parameters summary */}
      {params && (
        <span className="text-zinc-500 truncate">{params}</span>
      )}

      {/* Duration - right aligned */}
      {duration !== undefined && status !== 'pending' && (
        <span className="ml-auto text-zinc-600 text-xs flex-shrink-0">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  );
}
