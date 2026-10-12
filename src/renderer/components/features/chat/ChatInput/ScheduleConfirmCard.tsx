import React, { useMemo } from 'react';
import { Check, Clock3, X } from 'lucide-react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';
import type { PendingScheduleDraft } from './useScheduleDraft';
import { buildScheduleConfirmRows } from './scheduleConfirm';

interface ScheduleConfirmCardProps {
  draft: PendingScheduleDraft;
  confirming: boolean;
  onConfirm: () => void | Promise<unknown>;
  onDismiss: () => void;
}

export const ScheduleConfirmCard: React.FC<ScheduleConfirmCardProps> = ({
  draft,
  confirming,
  onConfirm,
  onDismiss,
}) => {
  const { t } = useI18n();
  const labels = t.scheduleConfirm;
  const rows = useMemo(() => buildScheduleConfirmRows(draft, labels), [draft, labels]);

  return (
    <div
      data-schedule-confirm
      className="mb-2 px-3 py-3 bg-indigo-500/10 border border-badge-accent/20 rounded-lg animate-fadeIn"
    >
      <div className="flex items-start gap-2">
        <Clock3 className="w-4 h-4 text-badge-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-badge-accent">{labels.title}</div>
          <div className="mt-0.5 text-[11px] text-badge-accent/60 leading-relaxed">{labels.description}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={confirming}
          title={labels.cancel}
          aria-label={labels.cancel}
          leftIcon={<X className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="mt-2.5 space-y-1.5">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[auto_1fr] gap-3 rounded-md bg-indigo-500/5 px-2.5 py-1.5">
            <span className="text-[10px] text-badge-accent/55">{row.label}</span>
            <span className="min-w-0 text-[11px] leading-relaxed text-zinc-200">{row.value}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-schedule-confirm-cancel
          onClick={onDismiss}
          disabled={confirming}
        >
          {labels.cancel}
        </Button>
        <Button
          type="button"
          data-schedule-confirm-submit
          size="sm"
          onClick={() => void onConfirm()}
          loading={confirming}
          leftIcon={<Check className="h-3 w-3" />}
        >
          {labels.confirm}
        </Button>
      </div>
    </div>
  );
};
