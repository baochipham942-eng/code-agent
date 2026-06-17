// ============================================================================
// PlanPanel - 实现计划展示面板
// 展示当前会话的任务计划
// ============================================================================

import React from 'react';
import { X, FileText, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { TaskPlan, TaskPhase, TaskStep } from '@shared/contract';
import { IconButton, Modal } from '../../primitives';

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
            : 'text-zinc-400'
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
    <Modal
      isOpen={true}
      onClose={onClose}
      title={plan.title}
      size="xl"
      header={
        <>
          <div className="p-2 bg-indigo-500/20 rounded-lg shrink-0">
            <FileText className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-zinc-200 truncate">{plan.title}</h3>
            <p className="text-xs text-zinc-500">
              进度: {plan.metadata.completedSteps}/{plan.metadata.totalSteps} 步骤
            </p>
          </div>
          <IconButton
            variant="default"
            size="md"
            icon={<X className="w-5 h-5" />}
            aria-label="关闭"
            onClick={onClose}
          />
        </>
      }
      footer={
        <p className="flex-1 text-xs text-zinc-500">
          创建于 {new Date(plan.createdAt).toLocaleString('zh-CN')}
          {plan.updatedAt !== plan.createdAt && (
            <> · 更新于 {new Date(plan.updatedAt).toLocaleString('zh-CN')}</>
          )}
        </p>
      }
    >
      {/* Progress Bar */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm font-medium text-zinc-400">{progress}%</span>
      </div>

      {/* Objective */}
      {plan.objective && (
        <div className="mb-3 p-3 rounded-lg bg-zinc-800 border border-zinc-700">
          <p className="text-sm text-zinc-400">
            <span className="font-medium text-zinc-400">目标: </span>
            {plan.objective}
          </p>
        </div>
      )}

      {/* Plan Content */}
      {plan.phases.map((phase) => (
        <PhaseSection key={phase.id} phase={phase} />
      ))}
    </Modal>
  );
};

export default PlanPanel;
