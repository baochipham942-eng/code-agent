import React from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { parseContextCompressionSignal } from '../contextCompressionSignal';

export const ContextCompressionSignalBanner: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const signal = parseContextCompressionSignal(content);
  if (!signal) return null;

  const copy = t.notices.contextCompression;
  const text = copy[signal.code] ?? copy.fallback;
  const Icon = signal.kind === 'success'
    ? CheckCircle2
    : signal.kind === 'overflow-recovery'
      ? RefreshCw
      : signal.kind === 'paused'
        ? ShieldAlert
        : AlertTriangle;

  return (
    <div className="my-1 flex min-w-0 items-start gap-2 rounded-md border border-badge-warning/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-badge-warning" data-testid="context-compression-signal">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
};
