import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { DeliverableEvidenceStatus } from '@shared/contract';
import { useI18n } from '../hooks/useI18n';

export const DeliverableStatusBadge: React.FC<{ status: DeliverableEvidenceStatus }> = ({ status }) => {
  const { t } = useI18n();
  const verified = status === 'verified';
  const failed = status === 'failed';

  return (
    <span
      data-testid="preview-deliverable-status"
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        verified
          ? 'bg-emerald-500/12 text-badge-success'
          : failed
            ? 'bg-rose-500/12 text-badge-danger'
            : 'bg-amber-500/12 text-badge-warning'
      }`}
    >
      {verified
        ? <CheckCircle2 className="h-3 w-3" />
        : <AlertTriangle className="h-3 w-3" />}
      {verified
        ? t.deliverable.statusVerified
        : failed
          ? t.deliverable.statusFailed
          : t.deliverable.statusUnverified}
    </span>
  );
};
