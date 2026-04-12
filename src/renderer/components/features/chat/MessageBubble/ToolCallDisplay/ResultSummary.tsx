// ============================================================================
// ResultSummary - Result summary line with ⎿ indent connector
// Aligned with StatusIndicator width (w-4)
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { summarizeTool } from './summarizers';

interface Props {
  toolCall: ToolCall;
}

export function ResultSummary({ toolCall }: Props) {
  const summary = summarizeTool(toolCall);
  const isError = toolCall.result && !toolCall.result.success;

  if (!summary) return null;

  return (
    <div className="ml-6 text-xs">
      <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
        {summary}
      </span>
    </div>
  );
}
