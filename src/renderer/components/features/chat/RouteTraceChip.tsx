import React from 'react';
import { AlertTriangle, GitBranch } from 'lucide-react';
import type { ModelDecisionEventData, ModelDecisionReason } from '@shared/contract';

const REASON_LABELS: Record<ModelDecisionReason, string> = {
  'user-selected': '用户选择',
  'role-tier': '角色档位',
  'simple-task-free': '简单任务',
  'billing-gate-skip': '计费跳过',
  'strategy-fast': '快速策略',
  'strategy-main': '主任务策略',
  'strategy-deep': '深度策略',
  'strategy-vision': '视觉策略',
  'capability-vision': '视觉能力',
  'fallback-availability': '可用性降级',
};

function getToneClass(reason: ModelDecisionReason): string {
  switch (reason) {
    case 'simple-task-free':
    case 'strategy-fast':
      return 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-200';
    case 'strategy-main':
      return 'border-blue-500/20 bg-blue-500/[0.08] text-blue-200';
    case 'strategy-deep':
      return 'border-violet-500/20 bg-violet-500/[0.08] text-violet-200';
    case 'strategy-vision':
      return 'border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-200';
    case 'billing-gate-skip':
      return 'border-amber-500/20 bg-amber-500/[0.08] text-amber-200';
    case 'capability-vision':
      return 'border-sky-500/20 bg-sky-500/[0.08] text-sky-200';
    case 'fallback-availability':
      return 'border-red-500/20 bg-red-500/[0.08] text-red-200';
    case 'role-tier':
      return 'border-violet-500/20 bg-violet-500/[0.08] text-violet-200';
    default:
      return 'border-white/[0.08] bg-white/[0.04] text-zinc-300';
  }
}

function formatModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export const RouteTraceChip: React.FC<{ decision: ModelDecisionEventData }> = ({ decision }) => {
  const requested = formatModel(decision.requestedProvider, decision.requestedModel);
  const resolved = formatModel(decision.resolvedProvider, decision.resolvedModel);
  const changed = requested !== resolved;
  const label = REASON_LABELS[decision.reason];

  return (
    <div
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-none ${getToneClass(decision.reason)}`}
      title={changed ? `${requested} -> ${resolved}` : resolved}
      data-testid="route-trace-chip"
    >
      {decision.reason === 'fallback-availability'
        ? <AlertTriangle className="h-3 w-3 shrink-0" />
        : <GitBranch className="h-3 w-3 shrink-0" />}
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate font-mono text-[10px] opacity-80">
        {changed ? `${decision.requestedModel} -> ${decision.resolvedModel}` : decision.resolvedModel}
      </span>
    </div>
  );
};
