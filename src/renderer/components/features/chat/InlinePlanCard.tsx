// ============================================================================
// InlinePlanCard - 内联在消息流中的计划卡片
// 替代全屏模态的 PlanPanel，用户可以在对话上下文中查看计划进度
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Circle, Loader2, FileText } from 'lucide-react';
import type { TaskPlan, TaskPhase, TaskStep } from '@shared/contract';

interface InlinePlanCardProps {
  plan: TaskPlan;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Circle className="w-3.5 h-3.5 text-zinc-500" />,
  in_progress: <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />,
  blocked: <Circle className="w-3.5 h-3.5 text-red-400" />,
  skipped: <Circle className="w-3.5 h-3.5 text-zinc-600" />,
};

const StepItem: React.FC<{ step: TaskStep }> = ({ step }) => (
  <li className="flex items-start gap-2 py-0.5">
    <span className="mt-0.5">{STATUS_ICONS[step.status]}</span>
    <span
      className={`text-xs ${
        step.status === 'completed'
          ? 'text-zinc-500 line-through'
          : step.status === 'in_progress'
            ? 'text-yellow-300'
            : 'text-zinc-400'
      }`}
    >
      {step.content}
    </span>
  </li>
);

const PhaseSection: React.FC<{ phase: TaskPhase }> = ({ phase }) => (
  <div className="mb-2">
    <div className="flex items-center gap-2 mb-1">
      <span className="mt-0.5">{STATUS_ICONS[phase.status]}</span>
      <span
        className={`text-sm font-medium ${
          phase.status === 'completed'
            ? 'text-zinc-500'
            : phase.status === 'in_progress'
              ? 'text-yellow-300'
              : 'text-zinc-200'
        }`}
      >
        {phase.title}
      </span>
    </div>
    <ul className="ml-6 space-y-0">
      {phase.steps.map((step) => (
        <StepItem key={step.id} step={step} />
      ))}
    </ul>
  </div>
);

export const InlinePlanCard: React.FC<InlinePlanCardProps> = ({ plan }) => {
  const [expanded, setExpanded] = useState(true);

  const { completedSteps, totalSteps } = plan.metadata;
  const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return (
    <div className="mx-4 my-2">
      <div className="bg-zinc-900 rounded-lg border border-indigo-500/30 overflow-hidden">
        {/* Header - clickable to expand/collapse */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/50 transition-colors"
        >
          <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />
          <span className="text-sm font-medium text-zinc-200 truncate">{plan.title}</span>
          <span className="text-xs text-zinc-500 flex-shrink-0 ml-auto mr-2">
            {completedSteps}/{totalSteps}
          </span>
          {/* Mini progress bar */}
          <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden flex-shrink-0">
            <div
              className="h-full bg-indigo-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          {expanded
            ? <ChevronDown className="w-4 h-4 text-zinc-500 flex-shrink-0" />
            : <ChevronRight className="w-4 h-4 text-zinc-500 flex-shrink-0" />
          }
        </button>

        {/* Expandable content */}
        {expanded && (
          <div className="px-3 pb-3 border-t border-zinc-800">
            {plan.objective && (
              <p className="text-xs text-zinc-500 mt-2 mb-2">{plan.objective}</p>
            )}
            {plan.phases.map((phase) => (
              <PhaseSection key={phase.id} phase={phase} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
