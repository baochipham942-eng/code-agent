// ============================================================================
// PinnedTodoBar - 粘在 ChatInput 上方的 todo 进度面板（Codex 风格）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { CheckSquare, Square, Minimize2, Maximize2, Loader2 } from 'lucide-react';
import type { TaskPlan, TaskStep } from '@shared/contract';

interface PinnedTodoBarProps {
  plan: TaskPlan | null;
  sessionId: string | null;
}

export const PinnedTodoBar: React.FC<PinnedTodoBarProps> = ({ plan, sessionId }) => {
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    setCollapsed(true);
  }, [sessionId]);

  if (!plan || plan.phases.length === 0) return null;
  const steps: TaskStep[] = plan.phases.flatMap((p) => p.steps);
  if (steps.length === 0) return null;

  const completedSteps = steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const totalSteps = steps.length;
  const activeStep = steps.find((step) => step.status === 'in_progress')
    || steps.find((step) => step.status !== 'completed' && step.status !== 'skipped')
    || steps[steps.length - 1];
  const remainingCount = Math.max(0, totalSteps - completedSteps);

  return (
    <div className="px-4 shrink-0">
      <div className="mb-2 max-w-3xl mx-auto">
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] backdrop-blur-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors text-left"
            aria-expanded={!collapsed}
            title={collapsed ? '展开任务列表' : '折叠任务列表'}
          >
            <CheckSquare className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            <span className="text-xs text-zinc-500 flex-shrink-0">
              {completedSteps}/{totalSteps}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
              {activeStep?.status === 'in_progress' ? activeStep.activeForm || activeStep.content : activeStep?.content}
            </span>
            <span className="text-[11px] text-zinc-600 flex-shrink-0">
              {remainingCount === 0 ? '完成' : `剩余 ${remainingCount}`}
            </span>
            {collapsed ? (
              <Maximize2 className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            ) : (
              <Minimize2 className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            )}
          </button>
          {!collapsed && (
            <ul className="px-3 pb-2 pt-1 space-y-1">
              {steps.map((step, idx) => (
                <TodoStepItem key={step.id} step={step} index={idx + 1} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

const TodoStepItem: React.FC<{ step: TaskStep; index: number }> = ({ step, index }) => {
  const isCompleted = step.status === 'completed';
  const isInProgress = step.status === 'in_progress';
  const isSkipped = step.status === 'skipped';

  return (
    <li className="flex items-start gap-2 py-0.5">
      <span className="mt-[2px] flex-shrink-0">
        {isInProgress ? (
          <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
        ) : isCompleted ? (
          <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <Square className="w-3.5 h-3.5 text-zinc-500" />
        )}
      </span>
      <span
        className={`text-xs leading-relaxed ${
          isCompleted
            ? 'text-zinc-500 line-through'
            : isSkipped
              ? 'text-zinc-600'
              : isInProgress
                ? 'text-amber-200'
                : 'text-zinc-300'
        }`}
      >
        <span className="text-zinc-600 mr-1.5">{index}.</span>
        {step.content}
      </span>
    </li>
  );
};
