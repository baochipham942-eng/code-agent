// ============================================================================
// ResultSummary - Result summary line with ⎿ indent connector
// Aligned with StatusIndicator width (w-4)
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/types';
import { summarizeTool } from './summarizers';

interface Props {
  toolCall: ToolCall;
}

export function ResultSummary({ toolCall }: Props) {
  const summary = summarizeTool(toolCall);
  const isError = toolCall.result && !toolCall.result.success;

  if (!summary) return null;

  return (
    <div className="flex items-start gap-1.5 pl-1 text-xs">
      {/* ⎿ connector - same width as StatusIndicator (w-4) */}
      <span
        className="w-4 flex-shrink-0 text-center"
        style={{ color: isError ? 'var(--cc-error)' : 'var(--cc-gutter)' }}
      >
        ⎿
      </span>
      <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
        {summary}
      </span>
    </div>
  );
}
