// ============================================================================
// PinnedTodoBar - 粘在 ChatInput 上方的 todo 进度面板（Codex 风格）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { CheckSquare, Square, Minimize2, Maximize2, Loader2 } from 'lucide-react';
import type { TaskPlan, TaskStep } from '@shared/contract';
import { todoEvidenceLabel, todoEvidenceOf, type TodoEvidence } from '../../../utils/todoEvidence';

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
    <div className="chat-col-pad shrink-0">
      <div className="mb-2 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border-muted bg-surface-subtle backdrop-blur-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover transition-colors text-left"
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
                <TodoStepItem key={step.id} step={step} index={idx + 1} sessionId={sessionId} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

function correctionKey(sessionId: string | null, stepId: string): string {
  return `todo-correction:${sessionId ?? 'none'}:${stepId}`;
}

function readCorrection(sessionId: string | null, stepId: string, content: string): string | null {
  if (!sessionId) return null;
  const raw = sessionStorage.getItem(correctionKey(sessionId, stepId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { base?: string; text?: string };
    return parsed.base === content && parsed.text ? parsed.text : null;
  } catch {
    return null;
  }
}

const TodoStepItem: React.FC<{ step: TaskStep; index: number; sessionId: string | null }> = ({ step, index, sessionId }) => {
  const isCompleted = step.status === 'completed';
  const isInProgress = step.status === 'in_progress';
  const isSkipped = step.status === 'skipped';
  const [draft, setDraft] = useState<string | null>(null);
  const [correction, setCorrection] = useState<string | null>(() => readCorrection(sessionId, step.id, step.content));
  useEffect(() => {
    setCorrection(readCorrection(sessionId, step.id, step.content));
    setDraft(null);
  }, [sessionId, step.id, step.content]);
  const evidence: TodoEvidence = correction ? 'user' : todoEvidenceOf(step.metadata);
  const text = correction ?? step.content;

  const save = () => {
    const next = (draft ?? text).trim();
    if (!next || next === step.content) {
      setCorrection(null);
      setDraft(null);
      if (sessionId) sessionStorage.removeItem(correctionKey(sessionId, step.id));
      return;
    }
    setCorrection(next);
    if (sessionId) {
      sessionStorage.setItem(correctionKey(sessionId, step.id), JSON.stringify({ base: step.content, text: next }));
    }
    setDraft(null);
  };

  return (
    <li className="flex items-start gap-2 py-0.5" data-testid={`todo-step-${step.id}`}>
      <span className="mt-[2px] flex-shrink-0">
        {isInProgress ? (
          <Loader2 className="w-3.5 h-3.5 text-badge-warning animate-spin" />
        ) : isCompleted ? (
          <CheckSquare className="w-3.5 h-3.5 text-badge-success" />
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
                ? 'text-badge-warning'
                : 'text-zinc-300'
        }`}
      >
        <span className="text-zinc-600 mr-1.5">{index}.</span>
        {draft !== null ? (
          <input
            data-testid={`todo-edit-${step.id}`}
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
        ) : (
          <button
            type="button"
            className="text-left"
            title="只改你看到的这行，不会改 agent 的计划"
            onClick={() => setDraft(text)}
          >
            {text}
          </button>
        )}
        <span
          data-testid={`todo-evidence-${step.id}`}
          className="ml-1 shrink-0 text-[10px] text-zinc-500"
        >
          {todoEvidenceLabel(evidence)}
        </span>
      </span>
    </li>
  );
};
