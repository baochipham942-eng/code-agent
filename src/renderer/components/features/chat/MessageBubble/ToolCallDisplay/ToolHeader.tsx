// ============================================================================
// ToolHeader - Tool name + params + duration (no icon, no LoadingDots)
// Status is expressed by parent StatusIndicator
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/types';
import { formatParams, formatDuration, getToolDisplayName } from './utils';
import type { ToolStatus } from './styles';

interface Props {
  toolCall: ToolCall;
  status: ToolStatus;
}

export function ToolHeader({ toolCall, status }: Props) {
  const displayName = getToolDisplayName(toolCall.name);
  const params = formatParams(toolCall);
  const duration = toolCall.result?.duration;
  const isSandboxed = (toolCall.name === 'bash' || toolCall.name === 'Bash') &&
    typeof toolCall.result?.output === 'string' &&
    toolCall.result.output.includes('[codex-sandbox]');

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {/* Tool name - always semibold, neutral color */}
      <span className="text-zinc-200 font-semibold">{displayName}</span>

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
