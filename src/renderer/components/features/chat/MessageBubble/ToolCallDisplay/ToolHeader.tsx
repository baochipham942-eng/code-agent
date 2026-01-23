// ============================================================================
// ToolHeader - Single line header with tool name, params, and duration
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/types';
import { getToolIcon, formatParams, formatDuration, getToolDisplayName } from './utils';
import { getNameColor, type ToolStatus } from './styles';

interface Props {
  toolCall: ToolCall;
  status: ToolStatus;
}

export function ToolHeader({ toolCall, status }: Props) {
  const icon = getToolIcon(toolCall.name);
  const displayName = getToolDisplayName(toolCall.name);
  const params = formatParams(toolCall);
  const duration = toolCall.result?.duration;

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {/* Tool icon */}
      <span className="text-gray-400 flex-shrink-0">{icon}</span>

      {/* Tool name */}
      <span className={`font-medium ${getNameColor(status)}`}>{displayName}</span>

      {/* Parameters summary */}
      {params && (
        <span className="text-gray-500 truncate">({params})</span>
      )}

      {/* Duration - right aligned */}
      {duration !== undefined && status !== 'pending' && (
        <span className="ml-auto text-gray-600 text-xs flex-shrink-0">
          {formatDuration(duration)}
        </span>
      )}

      {/* Loading animation for pending */}
      {status === 'pending' && (
        <span className="ml-auto flex-shrink-0">
          <LoadingDots />
        </span>
      )}
    </div>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-0.5 text-cyan-400">
      <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}
