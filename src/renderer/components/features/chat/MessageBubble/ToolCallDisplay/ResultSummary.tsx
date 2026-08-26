// ============================================================================
// ResultSummary - Result summary line with ⎿ indent connector
// Aligned with StatusIndicator width (w-4)
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { summarizeTool } from './summarizers';
import { useI18n } from '../../../../../hooks/useI18n';
import { humanizeToolError } from '../../../../../utils/toolExecutionPresentation';

interface Props {
  toolCall: ToolCall;
}

export function ResultSummary({ toolCall }: Props) {
  const { t } = useI18n();
  const isError = toolCall.result && !toolCall.result.success;
  const summary = isError
    ? humanizeToolError(toolCall.result?.error, toolCall.name, t)?.summary ?? t.systemError.fallbackSummary
    : summarizeTool(toolCall);

  if (!summary) return null;

  return (
    <div className="ml-6 text-xs">
      <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
        {summary}
      </span>
    </div>
  );
}
