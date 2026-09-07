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
import { isEmptyMatchForStatusLine } from './statusLabels';

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
    : collapsedSuccessSummary(summarizeTool(toolCall), toolCall);

  if (!summary) return null;

  const content = (
    <span className={isError ? 'text-[var(--cc-error)]' : 'text-zinc-500'}>
      {summary}
    </span>
  );

  return inline ? content : <div className="ml-6 text-xs">{content}</div>;
}

/** 只有 Grep/Glob 的状态行会替它说「无匹配」，别的工具删掉摘要就等于什么都没说。 */
const SUMMARY_OWNED_BY_STATUS_LINE = new Set(['Grep', 'Glob']);

function collapsedSuccessSummary(summary: string | null, toolCall: ToolCall): string | null {
  if (!summary) return null;
  // 只有状态行**真的**接管了这句才隐藏摘要。拿不到 metadata.totalMatches 时状态行什么都不说
  // （不猜），这时再把摘要删掉，折叠行就一个字都没有了（ai-review #1693 Nit）。
  // 与状态行同一判据：只有状态行真的接管了这句才隐藏摘要（含没有计数时的回落档）。
  if (!isEmptyMatchForStatusLine(toolCall)) return summary;
  const toolName = toolCall.name;
  // grep/glob empty stdout is already the statusLabel (无匹配); keep raw English in details.
  // 🔴 只对这两个工具成立：mcp__github__search_code 之类同样会返回 'No matches found'，
  // 但它们的状态行不产出「无匹配」，删掉摘要后折叠行只剩动作名，用户看不出找没找到
  // （ai-review #1693 第三轮）。
  if (SUMMARY_OWNED_BY_STATUS_LINE.has(toolName) && isRawToolStdoutNoMatches(summary)) return null;
  return summary;
}

/** 测试出口：折叠行摘要的隐藏范围是安全边界，值得单独钉住。 */
export const collapsedSuccessSummaryForTest = collapsedSuccessSummary;
