// ============================================================================
// Turn List - 轮次列表
// ============================================================================

import React from 'react';
import type { TelemetryTurn } from '@shared/types/telemetry';
import { Wrench, MessageSquare, CheckCircle, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';

interface TurnListProps {
  turns: TelemetryTurn[];
  selectedTurnId?: string;
  onSelectTurn: (turnId: string) => void;
}

const INTENT_LABELS: Record<string, string> = {
  code_generation: '代码生成',
  bug_fix: '修复 Bug',
  code_review: '代码审查',
  explanation: '解释',
  refactoring: '重构',
  file_operation: '文件操作',
  search: '搜索',
  conversation: '对话',
  planning: '规划',
  multi_step_task: '多步任务',
  testing: '测试',
  documentation: '文档',
  configuration: '配置',
  research: '研究',
  unknown: '未知',
};

const INTENT_COLORS: Record<string, string> = {
  code_generation: 'bg-blue-500/20 text-blue-400',
  bug_fix: 'bg-red-500/20 text-red-400',
  search: 'bg-cyan-500/20 text-cyan-400',
  conversation: 'bg-zinc-500/20 text-zinc-400',
  explanation: 'bg-purple-500/20 text-purple-400',
  refactoring: 'bg-amber-500/20 text-amber-400',
  multi_step_task: 'bg-green-500/20 text-green-400',
};

const OutcomeIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'success': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />;
    case 'partial': return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
    case 'failure': return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    default: return <HelpCircle className="w-3.5 h-3.5 text-zinc-500" />;
  }
};

export const TurnList: React.FC<TurnListProps> = ({ turns, selectedTurnId, onSelectTurn }) => {
  return (
    <div className="space-y-1 overflow-y-auto max-h-[calc(100vh-300px)]">
      {turns.map((turn) => {
        const isSelected = turn.id === selectedTurnId;
        const intentColor = INTENT_COLORS[turn.intent.primary] ?? 'bg-zinc-500/20 text-zinc-400';
        const toolCount = turn.toolCalls?.length ?? 0;

        return (
          <button
            key={turn.id}
            onClick={() => onSelectTurn(turn.id)}
            className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
              isSelected
                ? 'bg-zinc-700/50 border-zinc-600'
                : 'bg-zinc-800/30 border-transparent hover:bg-zinc-800/50 hover:border-zinc-700/50'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-zinc-500">#{turn.turnNumber}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${intentColor}`}>
                  {INTENT_LABELS[turn.intent.primary] ?? turn.intent.primary}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <OutcomeIcon status={turn.outcome.status} />
                <span className="text-[10px] text-zinc-500">
                  {(turn.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
            </div>

            <p className="text-xs text-zinc-300 truncate">
              {turn.userPrompt.substring(0, 100)}
            </p>

            {toolCount > 0 && (
              <div className="flex items-center gap-1 mt-1 text-[10px] text-zinc-500">
                <Wrench className="w-3 h-3" />
                <span>{toolCount} 个工具</span>
                {turn.totalInputTokens > 0 && (
                  <>
                    <span>·</span>
                    <MessageSquare className="w-3 h-3" />
                    <span>{Math.round((turn.totalInputTokens + turn.totalOutputTokens) / 1000)}K tokens</span>
                  </>
                )}
              </div>
            )}
          </button>
        );
      })}

      {turns.length === 0 && (
        <div className="text-center text-zinc-500 text-sm py-8">
          暂无轮次数据
        </div>
      )}
    </div>
  );
};
