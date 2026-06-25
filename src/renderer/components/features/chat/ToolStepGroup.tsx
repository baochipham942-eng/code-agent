// ============================================================================
// ToolStepGroup - 把相邻的工具调用折成一行 "Explored 2 files, 2 lists"
// 默认折叠，点击展开显示原 ToolCallDisplay 列表
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolCall } from '@shared/contract';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { summarizeTool } from './MessageBubble/ToolCallDisplay/summarizers';
import { buildStepLabel, buildSingleToolLabel } from '../../../utils/toolStepGrouping';
import {
  formatToolDuration,
  isAutoLoadedRetry,
} from '../../../utils/toolExecutionPresentation';

// 网络抓取类工具：失败多为反爬墙/限流瞬态噪音（与浏览器/电脑/文件操作的 actionable 失败不同）。
const NETWORK_FETCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch']);

interface ToolStepGroupProps {
  nodes: TraceNode[];
  sessionId?: string;
  /** Streaming turn: default expanded so user sees live progress */
  defaultExpanded?: boolean;
}

export const ToolStepGroup: React.FC<ToolStepGroupProps> = ({
  nodes,
  sessionId,
  defaultExpanded = false,
}) => {
  const label = useMemo(() => {
    if (nodes.length === 1) {
      const tc = nodes[0].toolCall;
      if (tc) return buildSingleToolLabel(
        tc.name,
        tc.args as Record<string, unknown> | undefined,
        tc.shortDescription,
      );
    }
    const names = nodes
      .map((n) => n.toolCall?.name)
      .filter((x): x is string => !!x);
    return buildStepLabel(names);
  }, [nodes]);

  const status = useMemo<'streaming' | 'partial' | 'error' | 'ok'>(() => {
    let hasError = false;
    let hasSuccess = false;
    for (const n of nodes) {
      const tc = n.toolCall;
      if (!tc) continue;
      // 自动加载重试 + 已恢复的失败都是良性/已收尾状态，不参与组状态判定
      // （否则组会卡 error/partial、顶红、一直展开，把成功的一轮演成翻车）。
      if (isAutoLoadedRetry(tc.metadata) || tc.recovered) continue;
      if (tc._streaming) return 'streaming';
      if (tc.success === false) hasError = true;
      if (tc.success === true || (tc.result !== undefined && tc.success !== false)) {
        hasSuccess = true;
      }
    }
    if (hasError && hasSuccess) return 'partial';
    return hasError ? 'error' : 'ok';
  }, [nodes]);
  // 纯网络抓取组（WebSearch/WebFetch）的失败多是反爬墙/限流类瞬态噪音，撑开成报错墙
  // 反而干扰——这类组失败不强制展开，组头状态徽标已传达，需要细节再点开。
  // 浏览器/电脑操作/文件查找等组的失败是 actionable（且需展开做敏感数据脱敏展示），
  // 仍保持原来的失败即展开。
  const isNetworkFetchGroup = nodes.length > 0
    && nodes.every((n) => NETWORK_FETCH_TOOLS.has(n.toolCall?.name ?? ''));
  const forceExpandOnFailure = (status === 'error' || status === 'partial') && !isNetworkFetchGroup;
  const [expanded, setExpanded] = useState(defaultExpanded || forceExpandOnFailure);
  useEffect(() => {
    if (forceExpandOnFailure) {
      setExpanded(true);
    }
  }, [forceExpandOnFailure]);

  // 构造 ToolCallDisplay 需要的 ToolCall 对象
  const toolCalls = useMemo<ToolCall[]>(() => {
    return nodes
      .map((n) => {
        if (!n.toolCall) return null;
        const tc = n.toolCall;
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
          _streaming: tc._streaming,
          shortDescription: tc.shortDescription,
          targetContext: tc.targetContext,
          expectedOutcome: tc.expectedOutcome,
          result:
            tc.result !== undefined
              ? {
                  toolCallId: tc.id,
                  success: tc.success ?? true,
                  output: tc.success !== false ? tc.result : undefined,
                  error: tc.success === false ? tc.result : undefined,
                  duration: tc.duration,
                  outputPath: tc.outputPath,
                  metadata: tc.recovered
                    ? { ...(tc.metadata || {}), recovered: true }
                    : tc.metadata,
                }
              : undefined,
        } as ToolCall;
      })
      .filter((x): x is ToolCall => !!x);
  }, [nodes]);
  const resultSummary = useMemo(() => buildToolGroupHeadSummary(toolCalls), [toolCalls]);
  const outputCount = useMemo(() => {
    return toolCalls.filter((toolCall) => hasToolOutputArtifact(toolCall)).length;
  }, [toolCalls]);
  // 结局优先：这组里有多少次失败已被后续成功恢复——只用于安静地标个「已恢复」，不顶红。
  const recoveredCount = useMemo(
    () => nodes.filter((n) => n.toolCall?.recovered).length,
    [nodes],
  );
  const totalDuration = useMemo(() => {
    const total = toolCalls.reduce((sum, toolCall) => sum + (toolCall.result?.duration ?? 0), 0);
    return total > 0 ? formatToolDuration(total) : null;
  }, [toolCalls]);

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[11px] transition-colors ${
          status === 'ok'
            ? 'px-1 py-0.5 text-zinc-600 hover:bg-white/[0.018] hover:text-zinc-400'
            : 'border border-white/[0.04] bg-white/[0.015] px-2 py-1 text-zinc-500 hover:border-white/[0.08] hover:bg-white/[0.03] hover:text-zinc-300'
        }`}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-600" />
        )}
        {status === 'error' && (
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" aria-label="失败" />
        )}
        {status === 'partial' && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-label="部分失败" />
        )}
        {status !== 'ok' && (
          <span className={`flex-shrink-0 ${getToolGroupStatusClass(status)}`}>{getToolGroupStatusLabel(status)}</span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
        {recoveredCount > 0 && (
          <span
            className="flex-shrink-0 rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-zinc-500"
            title="这次失败后已自动恢复"
          >
            已恢复
          </span>
        )}
        {status !== 'ok' && resultSummary && (
          <span className="hidden max-w-[220px] truncate text-zinc-600 sm:inline">{resultSummary}</span>
        )}
        {status !== 'ok' && outputCount > 0 && (
          <span className="flex-shrink-0 rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-zinc-500">{outputCount} output{outputCount > 1 ? 's' : ''}</span>
        )}
        {totalDuration && (
          <span className="flex-shrink-0 text-[10px] text-zinc-600">{totalDuration}</span>
        )}
      </button>

      {expanded && (
        <div className="ml-4 mt-1 space-y-1 border-l border-zinc-800 pl-3">
          {toolCalls.map((tc, i) => (
            <div
              key={tc.id}
              data-trace-id={typeof tc.result?.metadata?.traceId === 'string' ? tc.result.metadata.traceId : undefined}
            >
              <ToolCallDisplay
                toolCall={tc}
                index={i}
                total={toolCalls.length}
                compact
                mediaContext={{
                  sessionId,
                  messageId: nodes.find((node) => node.toolCall?.id === tc.id)?.messageId || tc.id,
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function hasToolOutputArtifact(toolCall: ToolCall): boolean {
  if (toolCall.result?.outputPath) return true;
  const metadata = toolCall.result?.metadata;
  if (!metadata) return false;

  // `Read`/search tools often attach `metadata.filePath` for evidence context.
  // That is an input/evidence path, not a newly produced output artifact.
  if (isReadOrSearchTool(toolCall.name)) return false;

  return ['filePath', 'imagePath', 'videoPath', 'outputPath', 'pptxPath', 'pdfPath']
    .some((key) => typeof metadata[key] === 'string' && metadata[key]);
}

function isReadOrSearchTool(name: string): boolean {
  return [
    'Read',
    'read_file',
    'Grep',
    'Glob',
    'LS',
    'list_directory',
  ].includes(name);
}

/**
 * 组头摘要（P0 #1 失败去重）：
 *  · 多工具 → 计数（"N failed / M empty / K completed"），保留；
 *  · 单工具且失败 → null：错误**只**由下方工具 cell 单处渲染（红 glyph + 一行 humanize），
 *    组头不再重复同一条错误文本（去掉 summarizeTool 对失败返回的错误首行）；
 *  · 单工具其它（成功/空）→ summarizeTool 的结果摘要（如「找到 3 个文件」），保留。
 * 纯函数，便于单测。
 */
export function buildToolGroupHeadSummary(toolCalls: ToolCall[]): string | null {
  if (toolCalls.length === 0) return null;
  if (toolCalls.length > 1) return summarizeToolGroupResults(toolCalls);
  const only = toolCalls[0];
  if (only.result && only.result.success === false) return null;
  return summarizeTool(only);
}

function summarizeToolGroupResults(toolCalls: ToolCall[]): string | null {
  let failed = 0;
  let emptySearches = 0;
  let completed = 0;

  for (const toolCall of toolCalls) {
    const result = toolCall.result;
    if (!result) continue;
    // 自动加载重试 + 已恢复的失败不计入任何计数（否则会出现 "1 failed, 1 completed"
    // 这种自相矛盾，或把已被恢复的失败仍计成 failed）。
    if (isAutoLoadedRetry(result.metadata) || result.metadata?.recovered) continue;
    if (result.success === false) {
      failed += 1;
      continue;
    }
    if (isEmptySearchResult(toolCall)) {
      emptySearches += 1;
      continue;
    }
    completed += 1;
  }

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (emptySearches > 0) parts.push(`${emptySearches} empty`);
  if (completed > 0) parts.push(`${completed} completed`);

  return parts.length > 0 ? parts.join(', ') : null;
}

function isEmptySearchResult(toolCall: ToolCall): boolean {
  if (toolCall.name !== 'Grep' && toolCall.name !== 'Glob') return false;
  const output = toolCall.result?.output;
  if (typeof output !== 'string') return false;
  return /(?:No matches found|No files matched the pattern|No matches|0 matches)/i.test(output.trim());
}

function getToolGroupStatusLabel(status: 'streaming' | 'partial' | 'error' | 'ok'): string {
  if (status === 'streaming') return 'running';
  if (status === 'partial') return 'partial';
  if (status === 'error') return 'failed';
  return 'completed';
}

function getToolGroupStatusClass(status: 'streaming' | 'partial' | 'error' | 'ok'): string {
  if (status === 'streaming') return 'text-sky-300';
  if (status === 'partial') return 'text-amber-300';
  if (status === 'error') return 'text-red-300';
  return 'text-emerald-300';
}

