// ============================================================================
// Turn Detail - 轮次详情面板
// ============================================================================

import React, { useState } from 'react';
import type {
  TelemetryTurn,
  TelemetryModelCall,
  TelemetryToolCall,
  TelemetryTimelineEvent,
} from '@shared/types/telemetry';
import { ChevronDown, ChevronRight, CheckCircle, XCircle } from 'lucide-react';

interface TurnDetailProps {
  turn: TelemetryTurn;
  modelCalls: TelemetryModelCall[];
  toolCalls: TelemetryToolCall[];
  events: TelemetryTimelineEvent[];
}

const CollapsibleSection: React.FC<{
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, badge, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-700/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-2.5 bg-zinc-800/50 hover:bg-zinc-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />}
          <span className="text-xs font-medium text-zinc-300">{title}</span>
        </div>
        {badge && <span className="text-[10px] text-zinc-500">{badge}</span>}
      </button>
      {open && <div className="p-2.5 border-t border-zinc-700/50">{children}</div>}
    </div>
  );
};

export const TurnDetail: React.FC<TurnDetailProps> = ({ turn, modelCalls, toolCalls, events }) => {
  return (
    <div className="space-y-2">
      {/* User Prompt */}
      <CollapsibleSection title="用户输入" badge={`${turn.userPromptTokens} tokens`} defaultOpen>
        <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
          {turn.userPrompt}
        </pre>
      </CollapsibleSection>

      {/* Model Calls */}
      {modelCalls.length > 0 && (
        <CollapsibleSection title="模型调用" badge={`${modelCalls.length} 次`}>
          <div className="space-y-1">
            {modelCalls.map((mc) => (
              <div key={mc.id} className="flex items-center justify-between text-xs p-1.5 bg-zinc-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400">{mc.provider}/{mc.model}</span>
                  <span className="text-zinc-500">{mc.responseType}</span>
                </div>
                <div className="flex items-center gap-3 text-zinc-500">
                  <span>{mc.latencyMs}ms</span>
                  <span>{mc.toolCallCount > 0 ? `${mc.toolCallCount} tools` : ''}</span>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Tool Calls */}
      {toolCalls.length > 0 && (
        <CollapsibleSection title="工具调用" badge={`${toolCalls.length} 次`} defaultOpen>
          <div className="space-y-1">
            {toolCalls.map((tc) => (
              <div key={tc.id} className="flex items-center justify-between text-xs p-1.5 bg-zinc-900/50 rounded">
                <div className="flex items-center gap-2">
                  {tc.success ? (
                    <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                  )}
                  <span className="text-zinc-300 font-mono">{tc.name}</span>
                  {tc.parallel && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1 rounded">并行</span>}
                </div>
                <div className="flex items-center gap-2 text-zinc-500">
                  <span>{tc.durationMs}ms</span>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Assistant Response */}
      {turn.assistantResponse && (
        <CollapsibleSection title="助手回复" badge={`${turn.assistantResponseTokens} tokens`}>
          <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {turn.assistantResponse}
          </pre>
        </CollapsibleSection>
      )}

      {/* Thinking */}
      {turn.thinkingContent && (
        <CollapsibleSection title="思考过程">
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-32 overflow-y-auto italic">
            {turn.thinkingContent}
          </pre>
        </CollapsibleSection>
      )}

      {/* Outcome */}
      <CollapsibleSection title="结果评判" defaultOpen>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-zinc-900/50 p-2 rounded">
            <span className="text-zinc-500">状态</span>
            <p className="text-zinc-300 font-medium mt-0.5">{turn.outcome.status}</p>
          </div>
          <div className="bg-zinc-900/50 p-2 rounded">
            <span className="text-zinc-500">置信度</span>
            <p className="text-zinc-300 font-medium mt-0.5">{(turn.outcome.confidence * 100).toFixed(0)}%</p>
          </div>
          <div className="bg-zinc-900/50 p-2 rounded">
            <span className="text-zinc-500">工具成功率</span>
            <p className="text-zinc-300 font-medium mt-0.5">
              {(turn.outcome.signals.toolSuccessRate * 100).toFixed(0)}%
              ({turn.outcome.signals.toolCallCount} calls)
            </p>
          </div>
          <div className="bg-zinc-900/50 p-2 rounded">
            <span className="text-zinc-500">错误/恢复</span>
            <p className="text-zinc-300 font-medium mt-0.5">
              {turn.outcome.signals.errorCount} / {turn.outcome.signals.errorRecovered}
            </p>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
};
