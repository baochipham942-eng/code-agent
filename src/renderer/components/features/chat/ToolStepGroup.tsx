// ============================================================================
// ToolStepGroup - 把相邻的工具调用折成一行 "Explored 2 files, 2 lists"
// 默认折叠，点击展开显示原 ToolCallDisplay 列表
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, GitBranch } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolCall } from '@shared/contract';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { summarizeTool } from './MessageBubble/ToolCallDisplay/summarizers';
import { buildStepLabel, buildSingleToolLabel } from '../../../utils/toolStepGrouping';
import {
  formatToolDuration,
  summarizeToolLoopDecisionFromNodes,
  type ToolLoopDecisionSummary,
} from '../../../utils/toolExecutionPresentation';

interface ToolStepGroupProps {
  nodes: TraceNode[];
  /** Streaming turn: default expanded so user sees live progress */
  defaultExpanded?: boolean;
}

export const ToolStepGroup: React.FC<ToolStepGroupProps> = ({
  nodes,
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
      if (tc._streaming) return 'streaming';
      if (tc.success === false) hasError = true;
      if (tc.success === true || (tc.result !== undefined && tc.success !== false)) {
        hasSuccess = true;
      }
    }
    if (hasError && hasSuccess) return 'partial';
    return hasError ? 'error' : 'ok';
  }, [nodes]);
  const [expanded, setExpanded] = useState(defaultExpanded || status === 'error' || status === 'partial');
  useEffect(() => {
    if (status === 'error' || status === 'partial') {
      setExpanded(true);
    }
  }, [status]);

  const loopDecision = useMemo(
    () => summarizeToolLoopDecisionFromNodes(nodes),
    [nodes],
  );

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
                  metadata: tc.metadata,
                }
              : undefined,
        } as ToolCall;
      })
      .filter((x): x is ToolCall => !!x);
  }, [nodes]);
  const resultSummary = useMemo(() => {
    if (toolCalls.length === 0) return null;
    const summaries = toolCalls
      .map((toolCall) => summarizeTool(toolCall))
      .filter((summary): summary is string => Boolean(summary));
    if (summaries.length === 0) return null;
    if (toolCalls.length === 1) return summaries[0];
    return `${summaries.length}/${toolCalls.length} results`;
  }, [toolCalls]);
  const outputCount = useMemo(() => {
    return toolCalls.filter((toolCall) => hasToolOutputArtifact(toolCall)).length;
  }, [toolCalls]);
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

      <LoopDecisionRow decision={loopDecision} />

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
  return ['filePath', 'imagePath', 'videoPath', 'outputPath', 'pptxPath', 'pdfPath']
    .some((key) => typeof metadata[key] === 'string' && metadata[key]);
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

function getLoopDecisionToneClass(tone: ToolLoopDecisionSummary['tone']): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/15 bg-emerald-500/[0.06] text-emerald-300';
    case 'warning':
      return 'border-amber-500/15 bg-amber-500/[0.06] text-amber-300';
    case 'error':
      return 'border-red-500/15 bg-red-500/[0.06] text-red-300';
    default:
      return 'border-sky-500/15 bg-sky-500/[0.06] text-sky-300';
  }
}

const LoopDecisionRow: React.FC<{ decision: ToolLoopDecisionSummary | null }> = ({ decision }) => {
  if (!decision) return null;
  if (decision.tone === 'success') return null;

  return (
    <div className="mt-1 ml-0.5 flex min-w-0 items-center gap-2 rounded-md border border-white/[0.05] bg-white/[0.018] px-2 py-1 text-[11px]">
      <div className={`inline-flex flex-shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 ${getLoopDecisionToneClass(decision.tone)}`}>
        <GitBranch className="h-3 w-3" />
        <span>{decision.action}</span>
      </div>
      <span className="min-w-0 flex-1 truncate text-zinc-500">{decision.reason}</span>
      <span className="hidden max-w-[220px] truncate text-zinc-600 sm:block">{decision.expectedNextAction}</span>
    </div>
  );
};
