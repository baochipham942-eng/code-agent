// ============================================================================
// PlanningPanel - Task Plan Visualization (Gen 3+ Persistent Planning)
// ============================================================================

import React, { useState } from 'react';
import {
  Target,
  ChevronDown,
  ChevronRight,
  Circle,
  CheckCircle2,
  Loader2,
  XCircle,
  SkipForward,
  FileText,
} from 'lucide-react';
import type {
  TaskPlan,
  TaskPhase,
  TaskStep,
  TaskStepStatus,
  TaskPhaseStatus,
} from '@shared/types';

interface PlanningPanelProps {
  plan: TaskPlan | null;
  onRefresh?: () => void;
}

// Status icons for steps
const StepStatusIcon: React.FC<{ status: TaskStepStatus }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case 'in_progress':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case 'skipped':
      return <SkipForward className="w-4 h-4 text-zinc-500" />;
    default:
      return <Circle className="w-4 h-4 text-zinc-500" />;
  }
};

// Status icons for phases
const PhaseStatusIcon: React.FC<{ status: TaskPhaseStatus }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case 'in_progress':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case 'blocked':
      return <XCircle className="w-4 h-4 text-red-400" />;
    default:
      return <Circle className="w-4 h-4 text-zinc-500" />;
  }
};

// Individual step display
const StepItem: React.FC<{ step: TaskStep }> = ({ step }) => {
  const getStatusStyles = () => {
    switch (step.status) {
      case 'completed':
        return 'text-zinc-500 line-through';
      case 'in_progress':
        return 'text-zinc-100';
      case 'skipped':
        return 'text-zinc-600 line-through';
      default:
        return 'text-zinc-400';
    }
  };

  return (
    <div
      className={`flex items-start gap-2 py-1.5 px-2 rounded ${
        step.status === 'in_progress' ? 'bg-blue-500/10' : ''
      }`}
    >
      <div className="mt-0.5 flex-shrink-0">
        <StepStatusIcon status={step.status} />
      </div>
      <span className={`text-sm ${getStatusStyles()}`}>
        {step.status === 'in_progress' && step.activeForm
          ? step.activeForm
          : step.content}
      </span>
    </div>
  );
};

// Phase display with collapsible steps
const PhaseItem: React.FC<{ phase: TaskPhase; defaultExpanded?: boolean }> = ({
  phase,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const completedSteps = phase.steps.filter((s) => s.status === 'completed').length;
  const totalSteps = phase.steps.length;

  const getPhaseStyles = () => {
    switch (phase.status) {
      case 'completed':
        return 'border-green-500/30 bg-green-500/5';
      case 'in_progress':
        return 'border-blue-500/30 bg-blue-500/5';
      case 'blocked':
        return 'border-red-500/30 bg-red-500/5';
      default:
        return 'border-zinc-700 bg-zinc-800/30';
    }
  };

  return (
    <div className={`border rounded-lg mb-2 ${getPhaseStyles()}`}>
      {/* Phase header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-2 hover:bg-zinc-700/20 transition-colors rounded-t-lg"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        )}
        <PhaseStatusIcon status={phase.status} />
        <span className="text-sm font-medium text-zinc-200 flex-1 text-left">
          {phase.title}
        </span>
        <span className="text-xs text-zinc-500">
          {completedSteps}/{totalSteps}
        </span>
      </button>

      {/* Steps list */}
      {expanded && (
        <div className="px-2 pb-2 pl-8">
          {phase.steps.map((step) => (
            <StepItem key={step.id} step={step} />
          ))}
          {phase.notes && (
            <div className="mt-2 text-xs text-zinc-500 italic border-l-2 border-zinc-600 pl-2">
              {phase.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Empty state
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-center p-4">
    <FileText className="w-12 h-12 text-zinc-600 mb-3" />
    <p className="text-sm text-zinc-400">No active plan</p>
    <p className="text-xs text-zinc-500 mt-1">
      Use todo_write with persist=true to create a plan
    </p>
  </div>
);

// Main component
export const PlanningPanel: React.FC<PlanningPanelProps> = ({ plan, onRefresh: _onRefresh }) => {
  if (!plan) {
    return (
      <div className="w-80 border-l border-zinc-800 bg-zinc-900/50 flex flex-col">
        <div className="p-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-zinc-100">Task Plan</span>
          </div>
        </div>
        <EmptyState />
      </div>
    );
  }

  const { metadata } = plan;
  const progress =
    metadata.totalSteps > 0
      ? (metadata.completedSteps / metadata.totalSteps) * 100
      : 0;

  return (
    <div className="w-80 border-l border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 mb-1">
          <Target className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-medium text-zinc-100 flex-1 truncate">
            {plan.title}
          </span>
          <span className="text-xs text-zinc-500">
            {metadata.completedSteps}/{metadata.totalSteps}
          </span>
        </div>

        {/* Objective */}
        {plan.objective && (
          <p className="text-xs text-zinc-400 mb-2 line-clamp-2">
            {plan.objective}
          </p>
        )}

        {/* Progress bar */}
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Blocked warning */}
        {metadata.blockedSteps > 0 && (
          <div className="mt-2 flex items-center gap-1 text-xs text-red-400">
            <XCircle className="w-3 h-3" />
            <span>{metadata.blockedSteps} blocked</span>
          </div>
        )}
      </div>

      {/* Phases list */}
      <div className="flex-1 overflow-y-auto p-2">
        {plan.phases.map((phase, index) => (
          <PhaseItem
            key={phase.id}
            phase={phase}
            defaultExpanded={phase.status === 'in_progress' || index === 0}
          />
        ))}
      </div>

      {/* Footer with timestamp */}
      <div className="p-2 border-t border-zinc-800 text-xs text-zinc-500 text-center">
        Updated {new Date(plan.updatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
};
