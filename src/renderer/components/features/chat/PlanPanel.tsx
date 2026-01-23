// ============================================================================
// PlanPanel - 实现计划展示面板
// 展示当前会话的任务计划
// ============================================================================

import React from 'react';
import { X, FileText, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { TaskPlan, TaskPhase, TaskStep } from '@shared/types';

// ============================================================================
// 类型定义
// ============================================================================

interface PlanPanelProps {
  plan: TaskPlan;
  onClose: () => void;
}

// 状态图标映射
const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Circle className="w-4 h-4 text-zinc-500" />,
  in_progress: <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />,
  completed: <CheckCircle2 className="w-4 h-4 text-green-400" />,
  blocked: <Circle className="w-4 h-4 text-red-400" />,
  skipped: <Circle className="w-4 h-4 text-zinc-600 line-through" />,
};

// ============================================================================
// 子组件
// ============================================================================

const StepItem: React.FC<{ step: TaskStep }> = ({ step }) => (
  <li className="flex items-start gap-2 py-1">
    {STATUS_ICONS[step.status]}
    <span
      className={`text-sm ${
        step.status === 'completed'
          ? 'text-zinc-500 line-through'
          : step.status === 'in_progress'
            ? 'text-yellow-300'
            : 'text-zinc-300'
      }`}
    >
      {step.content}
    </span>
  </li>
);

const PhaseSection: React.FC<{ phase: TaskPhase }> = ({ phase }) => (
  <div className="mb-4">
    <div className="flex items-center gap-2 mb-2">
      {STATUS_ICONS[phase.status]}
      <h4
        className={`font-medium ${
          phase.status === 'completed'
            ? 'text-zinc-500'
            : phase.status === 'in_progress'
              ? 'text-yellow-300'
              : 'text-zinc-200'
        }`}
      >
        {phase.title}
      </h4>
    </div>
    {phase.notes && (
      <p className="text-xs text-zinc-500 ml-6 mb-2 italic">{phase.notes}</p>
    )}
    <ul className="ml-6 space-y-1">
      {phase.steps.map((step) => (
        <StepItem key={step.id} step={step} />
      ))}
    </ul>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const PlanPanel: React.FC<PlanPanelProps> = ({ plan, onClose }) => {
  const progress = plan.metadata.totalSteps > 0
    ? Math.round((plan.metadata.completedSteps / plan.metadata.totalSteps) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[80vh] bg-surface-900 rounded-xl shadow-2xl border border-zinc-700/50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/20 rounded-lg">
              <FileText className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-zinc-100">{plan.title}</h3>
              <p className="text-xs text-zinc-500">
                进度: {plan.metadata.completedSteps}/{plan.metadata.totalSteps} 步骤
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="px-6 py-3 border-b border-zinc-700/50">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-sm font-medium text-zinc-400">{progress}%</span>
          </div>
        </div>

        {/* Objective */}
        {plan.objective && (
          <div className="px-6 py-3 border-b border-zinc-700/50 bg-zinc-800/30">
            <p className="text-sm text-zinc-400">
              <span className="font-medium text-zinc-300">目标: </span>
              {plan.objective}
            </p>
          </div>
        )}

        {/* Plan Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {plan.phases.map((phase) => (
            <PhaseSection key={phase.id} phase={phase} />
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-700/50 bg-zinc-800/30">
          <p className="text-xs text-zinc-500">
            创建于 {new Date(plan.createdAt).toLocaleString('zh-CN')}
            {plan.updatedAt !== plan.createdAt && (
              <> · 更新于 {new Date(plan.updatedAt).toLocaleString('zh-CN')}</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PlanPanel;
