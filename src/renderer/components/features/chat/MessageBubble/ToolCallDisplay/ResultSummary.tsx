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
  inline?: boolean;
}

export function ResultSummary({ toolCall, inline = false }: Props) {
  const { t } = useI18n();
  const isError = toolCall.result && !toolCall.result.success;
  const humanizedError = isError
    ? humanizeToolError(toolCall.result?.error, toolCall.name, t, toolCall.result?.metadata)
    : null;
  const summary = isError
    ? humanizedError?.detail ?? humanizedError?.summary ?? t.systemError.fallbackSummary
    : summarizeTool(toolCall);

  if (!summary) return null;

  const content = (
    <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
      {summary}
    </span>
  );

  return inline ? content : <div className="ml-6 text-xs">{content}</div>;
}
