import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { parseModelFallbackNotice } from '../fallbackNotice';
import type {
  ModelFallbackStrategy,
  ModelFallbackToolPolicy,
  ModelFallbackTraceStep,
  ModelProviderIdentity,
} from '@shared/contract/modelDecision';
import { useI18n } from '../../../../hooks/useI18n';
import type { Translations } from '../../../../i18n';
import { getHumanToolLabel } from '../../../../utils/toolHumanLabel';

type FallbackCopy = Translations['rendererHumanPipe']['fallbackBanner'];

function formatStepTarget(step: ModelFallbackTraceStep): string {
  return step.model ? `${step.provider}/${step.model}` : step.provider;
}

function stepTitle(step: ModelFallbackTraceStep, copy: FallbackCopy): string {
  return [
    formatStepTarget(step),
    formatProviderIdentity(step.providerIdentity, copy),
    step.reason,
    step.detail,
  ].filter(Boolean).join(' · ');
}

function formatProviderIdentity(
  identity: ModelProviderIdentity | undefined,
  copy: FallbackCopy,
): string | null {
  if (!identity) return null;
  const parts = [
    identity.sourceLabel
      ? `${copy.source} ${identity.sourceLabel}`
      : identity.displayName
        ? `${copy.name} ${identity.displayName}`
        : null,
    identity.transportLabel
      ? `${copy.protocol} ${identity.transportLabel}`
      : identity.protocol
        ? `${copy.protocol} ${identity.protocol}`
        : null,
    identity.endpoint ? `${copy.endpoint} ${identity.endpoint}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const stepTone: Record<ModelFallbackTraceStep['status'], string> = {
  tried: 'border-zinc-700/70 bg-zinc-900/60 text-zinc-300',
  skipped: 'border-zinc-700/70 bg-zinc-950/50 text-zinc-500 line-through decoration-zinc-600',
  selected: 'border-badge-success/30 bg-emerald-500/10 text-badge-success',
  exhausted: 'border-red-500/30 bg-red-500/10 text-badge-danger',
};

function strategyLabel(strategy: ModelFallbackStrategy, copy: FallbackCopy): string {
  switch (strategy) {
    case 'adaptive-provider-fallback':
      return copy.strategies.provider;
    case 'adaptive-capability-fallback':
      return copy.strategies.capability;
    case 'adaptive-main-task-recovery':
      return copy.strategies.mainTask;
  }
}

function humanizeFallbackReason(category: string | undefined, copy: FallbackCopy): string {
  const normalized = (category || '').toLowerCase();
  if (normalized.includes('capability') || normalized.includes('vision')) return copy.reasons.capability;
  if (normalized.includes('quota') || normalized.includes('balance')) return copy.reasons.quota;
  if (normalized.includes('auth') || normalized.includes('key')) return copy.reasons.auth;
  if (normalized.includes('timeout')) return copy.reasons.timeout;
  if (normalized.includes('network') || normalized.includes('connect')) return copy.reasons.network;
  if (normalized.includes('provider') || normalized.includes('unavailable') || normalized.includes('overload')) {
    return copy.reasons.providerUnavailable;
  }
  return copy.reasons.generic;
}

function renderStepGroup(label: string, steps: ModelFallbackTraceStep[], copy: FallbackCopy) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-zinc-500">{label}</span>
      {steps.map((step, index) => (
        <span
          key={`${step.status}-${step.provider}-${step.model || ''}-${index}`}
          title={stepTitle(step, copy)}
          className={`max-w-[220px] truncate rounded border px-1.5 py-0.5 font-mono ${stepTone[step.status]}`}
        >
          {formatStepTarget(step)}
        </span>
      ))}
    </div>
  );
}

function renderToolPolicy(
  policy: ModelFallbackToolPolicy | undefined,
  copy: FallbackCopy,
  t: Translations,
) {
  if (policy?.status !== 'disabled' || policy.originalToolCount <= policy.effectiveToolCount) return null;
  const names = (policy.disabledToolNames ?? []).map((toolName) => getHumanToolLabel({
    toolName,
    labels: t.receiptPresentation.humanToolLabels,
  }));
  const preview = names.slice(0, 4).join(', ');
  const suffix = names.length > 4 ? ` +${names.length - 4}` : '';

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-zinc-500">{copy.toolsDisabled}</span>
      <span className="rounded border border-badge-warning/25 bg-orange-500/10 px-1.5 py-0.5 text-badge-warning">
        {policy.originalToolCount} → {policy.effectiveToolCount}
      </span>
      {preview && (
        <span className="max-w-[260px] truncate text-zinc-400" title={copy.hiddenTools}>
          {preview}{suffix}
        </span>
      )}
    </div>
  );
}

function renderIdentityLine(
  fromIdentity: ModelProviderIdentity | undefined,
  toIdentity: ModelProviderIdentity | undefined,
  copy: FallbackCopy,
) {
  const from = formatProviderIdentity(fromIdentity, copy);
  const to = formatProviderIdentity(toIdentity, copy);
  if (!from && !to) return null;

  return (
    <div className="mt-1 space-y-0.5 text-[10px] text-zinc-500">
      {from && <div className="min-w-0 truncate" title={from}>{copy.fromModel} · {from}</div>}
      {to && <div className="min-w-0 truncate" title={to}>{copy.currentModel} · {to}</div>}
    </div>
  );
}

export const FallbackBanner: React.FC<{ content: string; defaultExpanded?: boolean }> = ({
  content,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { t } = useI18n();
  const copy = t.rendererHumanPipe.fallbackBanner;
  const notice = parseModelFallbackNotice(content);
  if (!notice) return null;
  const tried = notice.tried?.filter((step) => step.status === 'tried') ?? [];
  const selected = notice.tried?.filter((step) => step.status === 'selected') ?? [];
  const exhausted = notice.tried?.filter((step) => step.status === 'exhausted') ?? [];
  const skipped = notice.skipped ?? [];

  return (
    <div className="my-1 min-w-0 rounded-md border border-badge-warning/25 bg-amber-500/[0.06] text-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-badge-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-badge-warning">{copy.summary}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {humanizeFallbackReason(notice.category, copy)}
          </div>
        </div>
        {expanded
          ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-warning" />
          : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-badge-warning" />}
      </button>
      {expanded && (
        <div className="min-w-0 px-3 pb-2" data-testid="fallback-diagnostics">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{copy.switchDetails}</div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
            <span>{copy.fromModel}</span>
            <span className="max-w-[180px] truncate font-mono text-zinc-400">{notice.from}</span>
            <span>→</span>
            <span>{copy.currentModel}</span>
            <span className="max-w-[180px] truncate font-mono text-zinc-400">{notice.to}</span>
          </div>
          <div className="mt-1 truncate text-[10px] text-zinc-600" title={notice.reason}>
            {copy.rawReason} · {notice.reason}
          </div>
          {notice.strategy && (
            <div className="mt-1">
              <span className="rounded border border-badge-warning/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] leading-none text-badge-warning">
                {strategyLabel(notice.strategy, copy)}
              </span>
            </div>
          )}
          {renderIdentityLine(notice.fromIdentity, notice.toIdentity, copy)}
          {renderStepGroup(copy.tried, tried, copy)}
          {renderStepGroup(copy.skipped, skipped, copy)}
          {renderStepGroup(copy.selected, selected, copy)}
          {renderStepGroup(copy.exhausted, exhausted, copy)}
          {renderToolPolicy(notice.toolPolicy, copy, t)}
        </div>
      )}
    </div>
  );
};
