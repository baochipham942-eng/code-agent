import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { parseModelFallbackNotice } from '../fallbackNotice';
import type { ModelFallbackStrategy, ModelFallbackToolPolicy, ModelFallbackTraceStep, ModelProviderIdentity } from '@shared/contract/modelDecision';

function formatStepTarget(step: ModelFallbackTraceStep): string {
  return step.model ? `${step.provider}/${step.model}` : step.provider;
}

function stepTitle(step: ModelFallbackTraceStep): string {
  return [
    formatStepTarget(step),
    formatProviderIdentity(step.providerIdentity),
    step.reason,
    step.detail,
  ].filter(Boolean).join(' · ');
}

function formatProviderIdentity(identity: ModelProviderIdentity | undefined): string | null {
  if (!identity) return null;
  const parts = [
    identity.sourceLabel
      ? `来源 ${identity.sourceLabel}`
      : identity.displayName
        ? `名称 ${identity.displayName}`
        : null,
    identity.transportLabel
      ? `协议 ${identity.transportLabel}`
      : identity.protocol
        ? `协议 ${identity.protocol}`
        : null,
    identity.endpoint ? `endpoint ${identity.endpoint}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const stepTone: Record<ModelFallbackTraceStep['status'], string> = {
  tried: 'border-zinc-700/70 bg-zinc-900/60 text-zinc-300',
  skipped: 'border-zinc-700/70 bg-zinc-950/50 text-zinc-500 line-through decoration-zinc-600',
  selected: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  exhausted: 'border-red-500/30 bg-red-500/10 text-red-200',
};

const STRATEGY_LABELS: Record<ModelFallbackStrategy, string> = {
  'adaptive-provider-fallback': '自动策略恢复',
  'adaptive-capability-fallback': '能力自动切换',
  'adaptive-main-task-recovery': '回到主任务模型',
};

const renderStepGroup = (label: string, steps: ModelFallbackTraceStep[]) => {
  if (steps.length === 0) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-zinc-500">{label}</span>
      {steps.map((step, index) => (
        <span
          key={`${step.status}-${step.provider}-${step.model || ''}-${index}`}
          title={stepTitle(step)}
          className={`max-w-[220px] truncate rounded border px-1.5 py-0.5 font-mono ${stepTone[step.status]}`}
        >
          {formatStepTarget(step)}
        </span>
      ))}
    </div>
  );
};

function renderToolPolicy(policy: ModelFallbackToolPolicy | undefined) {
  if (!policy || policy.status !== 'disabled' || policy.originalToolCount <= policy.effectiveToolCount) return null;
  const names = policy.disabledToolNames ?? [];
  const preview = names.slice(0, 4).join(', ');
  const suffix = names.length > 4 ? ` +${names.length - 4}` : '';
  const title = [
    policy.detail,
    names.length > 0 ? `disabled: ${names.join(', ')}` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]" title={title || undefined}>
      <span className="text-zinc-500">工具已关闭</span>
      <span className="rounded border border-orange-500/25 bg-orange-500/10 px-1.5 py-0.5 text-orange-200">
        {policy.originalToolCount} → {policy.effectiveToolCount}
      </span>
      {preview && (
        <span className="max-w-[260px] truncate font-mono text-zinc-400">
          {preview}{suffix}
        </span>
      )}
    </div>
  );
}

function renderIdentityLine(fromIdentity: ModelProviderIdentity | undefined, toIdentity: ModelProviderIdentity | undefined) {
  const from = formatProviderIdentity(fromIdentity);
  const to = formatProviderIdentity(toIdentity);
  if (!from && !to) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
      {from && (
        <span className="min-w-0 truncate" title={from}>
          原 {from}
        </span>
      )}
      {from && to && <span className="text-zinc-700">/</span>}
      {to && (
        <span className="min-w-0 truncate text-zinc-400" title={to}>
          现 {to}
        </span>
      )}
    </div>
  );
}

export const FallbackBanner: React.FC<{ content: string }> = ({ content }) => {
  const notice = parseModelFallbackNotice(content);
  if (!notice) return null;
  const tried = notice.tried?.filter((step) => step.status === 'tried') ?? [];
  const selected = notice.tried?.filter((step) => step.status === 'selected') ?? [];
  const exhausted = notice.tried?.filter((step) => step.status === 'exhausted') ?? [];
  const skipped = notice.skipped ?? [];

  return (
    <div className="my-1 flex min-w-0 items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-amber-200">模型已降级</div>
        {notice.strategy && (
          <div className="mt-1">
            <span className="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] leading-none text-amber-100">
              {STRATEGY_LABELS[notice.strategy]}
            </span>
          </div>
        )}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
          <span className="max-w-full truncate font-mono text-zinc-300">{notice.from}</span>
          <span className="text-zinc-600">-&gt;</span>
          <span className="max-w-full truncate font-mono text-zinc-300">{notice.to}</span>
          <span className="text-zinc-600">·</span>
          <span className="min-w-0 truncate text-amber-200/80">{notice.reason}</span>
        </div>
        {renderIdentityLine(notice.fromIdentity, notice.toIdentity)}
        {renderStepGroup('已尝试', tried)}
        {renderStepGroup('已跳过', skipped)}
        {renderStepGroup('已选用', selected)}
        {renderStepGroup('已耗尽', exhausted)}
        {renderToolPolicy(notice.toolPolicy)}
      </div>
    </div>
  );
};
