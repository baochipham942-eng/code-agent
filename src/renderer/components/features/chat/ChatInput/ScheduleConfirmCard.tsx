import React, { useMemo } from 'react';
import { Check, Clock3, Loader2, X } from 'lucide-react';
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
        <button
          type="button"
          onClick={onDismiss}
          disabled={confirming}
          className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
          title={labels.cancel}
          aria-label={labels.cancel}
        >
          <X className="w-3.5 h-3.5" />
        </button>
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
        <button
          type="button"
          data-schedule-confirm-cancel
          onClick={onDismiss}
          disabled={confirming}
          className="px-2.5 py-1 text-[11px] text-badge-accent/70 hover:text-badge-accent transition-colors disabled:opacity-50"
        >
          {labels.cancel}
        </button>
        <button
          type="button"
          data-schedule-confirm-submit
          onClick={() => void onConfirm()}
          disabled={confirming}
          className="flex items-center gap-1 px-3 py-1 text-xs bg-indigo-500/20 text-badge-accent rounded hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
        >
          {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          {labels.confirm}
        </button>
      </div>
    </div>
  );
};
