// ============================================================================
// ResultSummary - Result summary line with arrow prefix
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
    <div
      className={`ml-8 pl-2 text-xs ${isError ? 'text-red-400' : 'text-gray-500'}`}
    >
      <span className="text-gray-600 mr-1">↳</span>
      <span className="truncate">{summary}</span>
    </div>
  );
}
