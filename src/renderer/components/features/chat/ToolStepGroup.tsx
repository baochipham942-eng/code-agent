// ============================================================================
// ToolStepGroup - 把相邻的工具调用折成一行 "Explored 2 files, 2 lists"
// 默认折叠，点击展开显示原 ToolCallDisplay 列表
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolCall } from '@shared/contract';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { buildStepLabel, buildSingleToolLabel } from '../../../utils/toolStepGrouping';

interface ToolStepGroupProps {
  nodes: TraceNode[];
  /** Streaming turn: default expanded so user sees live progress */
  defaultExpanded?: boolean;
}

export const ToolStepGroup: React.FC<ToolStepGroupProps> = ({
  nodes,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

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

  // 任一 tool 失败则整行加红点；任一 tool 正在流式则不显示红点（避免误判）
  const status = useMemo<'streaming' | 'error' | 'ok'>(() => {
    let hasError = false;
    for (const n of nodes) {
      const tc = n.toolCall;
      if (!tc) continue;
      if (tc._streaming) return 'streaming';
      if (tc.success === false) hasError = true;
    }
    return hasError ? 'error' : 'ok';
  }, [nodes]);

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

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-full text-left py-0.5"
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
        <span className="truncate font-mono">{label}</span>
      </button>

      {expanded && (
        <div className="ml-4 mt-1 space-y-0 border-l border-zinc-800 pl-3">
          {toolCalls.map((tc, i) => (
            <ToolCallDisplay
              key={tc.id}
              toolCall={tc}
              index={i}
              total={toolCalls.length}
            />
          ))}
        </div>
      )}
    </div>
  );
};
