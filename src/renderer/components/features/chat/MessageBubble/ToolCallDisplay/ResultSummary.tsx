// ============================================================================
// ResultSummary - Result summary line with ⎿ indent connector
// Aligned with StatusIndicator width (w-4)
// ============================================================================

import React from 'react';
import type { ToolCall } from '@shared/contract';
import { summarizeTool } from './summarizers';
import { useI18n } from '../../../../../hooks/useI18n';
import {
  humanizeToolError,
  resolveToolTerminalOutcomeKey,
} from '../../../../../utils/toolExecutionPresentation';
import { isRawToolStdoutNoMatches } from '../../../../../utils/toolStatusLinePresentation';

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
  const outcome = isError
    ? t.outcomeWords[resolveToolTerminalOutcomeKey(toolCall)].timeline
    : null;
  const summary = isError
    ? (humanizedError
        ? [humanizedError.detail, humanizedError.summary]
        : [t.systemError.fallbackSummary])
        .find((candidate) => candidate && candidate !== outcome?.label && candidate !== outcome?.reason)
    : collapsedSuccessSummary(summarizeTool(toolCall));

  if (!summary) return null;

  const content = (
    <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
      {summary}
    </span>
  );

  return inline ? content : <div className="ml-6 text-xs">{content}</div>;
}

function collapsedSuccessSummary(summary: string | null): string | null {
  if (!summary) return null;
  // grep/glob empty stdout is already the statusLabel (无匹配); keep raw English in details.
  if (isRawToolStdoutNoMatches(summary)) return null;
  return summary;
}
