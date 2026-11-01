// ============================================================================
// CronEventDecisionsPanel —— 事件自动化的执行方式徽标 + 逐事件决策记录
// （N-TRIGGER-OBSERVE-MODE）。「本会执行」行高亮；「切换为自动执行」只能经确认弹窗，
// 真正的切换与变更记录在 host（cron:setEventActionMode）。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Eye, Zap } from 'lucide-react';
import type { CronEventDecision, CronJobDefinition } from '@shared/contract';
import { resolveCronEventActionMode } from '@shared/cronEventActionMode';
import { cronClient } from '../../../services/cronClient';
import { useCronStore } from '../../../stores/cronStore';
import { useI18n } from '../../../hooks/useI18n';
import { ConfirmDialog } from '../../composites/ConfirmDialog';
import { formatDateTime } from './types';

/** 决策行底色：「本会执行」是观察期要用户过目的，高亮。 */
function decisionRowClass(decision: CronEventDecision['decision']): string {
  switch (decision) {
    case 'would_act':
      return 'border-amber-500/40 bg-amber-500/10';
    case 'acted':
      return 'border-blue-500/30 bg-blue-500/5';
    case 'unavailable':
      return 'border-red-500/30 bg-red-500/5';
    default:
      return 'border-zinc-800 bg-zinc-950/40';
  }
}

export const CronEventDecisionsPanel: React.FC<{ job: CronJobDefinition }> = ({ job }) => {
  const { t } = useI18n();
  const copy = t.cronCenter.eventActionMode;
  const setEventActionMode = useCronStore((state) => state.setEventActionMode);
  const mode = resolveCronEventActionMode(job) ?? 'observe';
  const [decisions, setDecisions] = useState<CronEventDecision[]>([]);
  const [modeChange, setModeChange] = useState<{ from: 'observe' | 'auto'; to: 'observe' | 'auto'; at: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    Promise.resolve()
      .then(() => cronClient.getEventDecisions(job.id))
      .then((rows) => { if (!cancelled) setDecisions(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) { setDecisions([]); setLoadFailed(true); } });
    Promise.resolve()
      .then(() => cronClient.getEventActionModeChange(job.id))
      .then((entry) => { if (!cancelled) setModeChange(entry ?? null); })
      .catch(() => { if (!cancelled) setModeChange(null); });
    return () => { cancelled = true; };
  }, [job.id, job.updatedAt]);

  const confirmSwitch = async () => {
    setSwitching(true);
    setSwitchError(null);
    try {
      await setEventActionMode(job.id, 'auto');
      setConfirmOpen(false);
    } catch (error) {
      setSwitchError(copy.switchFailed.replace('{error}', error instanceof Error ? error.message : String(error)));
    } finally {
      setSwitching(false);
    }
  };

  // 「会接单但未执行」单独成节（返修③）：would_act 行（含观察档拦下的对外动作）与其余决策分开渲染。
  const wouldActRows = decisions.filter((row) => row.decision === 'would_act');
  const otherRows = decisions.filter((row) => row.decision !== 'would_act');

  const renderRow = (row: CronEventDecision, testId: string) => (
    <li
      key={row.id}
      data-testid={testId}
      data-decision={row.decision}
      data-highlight={row.decision === 'would_act' ? 'true' : undefined}
      className={`rounded-lg border px-3 py-2 text-xs ${decisionRowClass(row.decision)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-200">{copy.decision[row.decision]}</span>
        <span className="text-zinc-500">
          {row.kind === 'action'
            ? copy.actionLabel.replace('{tool}', row.tool ?? '')
            : copy.eventLabel.replace('{id}', row.eventId ?? '')}
        </span>
        {row.target && <span className="text-zinc-500">{copy.targetLabel.replace('{target}', row.target)}</span>}
        <span className="ml-auto text-zinc-600">{formatDateTime(row.createdAt)}</span>
      </div>
      <div className="mt-1 text-zinc-400">{row.reason}</div>
      {row.matchedRule && (
        <div className="mt-0.5 text-zinc-500" data-testid="cron-event-decision-rule">
          {copy.ruleLabel.replace('{rule}', row.matchedRule)}
        </div>
      )}
      {row.summary && <div className="mt-1 truncate text-zinc-300">{row.summary}</div>}
    </li>
  );

  return (
    <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3" data-testid="cron-event-decisions">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">{copy.label}</span>
        <span
          data-testid="cron-action-mode-badge"
          data-mode={mode}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
            mode === 'observe' ? 'bg-amber-500/10 text-badge-warning' : 'bg-blue-500/10 text-badge-info'
          }`}
        >
          {mode === 'observe' ? <Eye className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
          {mode === 'observe' ? copy.observe : copy.auto}
        </span>
        <span className="text-xs text-zinc-500">{mode === 'observe' ? copy.observeHint : copy.autoHint}</span>
        {mode === 'observe' && (
          <button
            type="button"
            data-testid="cron-switch-to-auto"
            onClick={() => { setSwitchError(null); setConfirmOpen(true); }}
            className="ml-auto text-xs text-badge-info hover:text-badge-info"
          >
            {copy.switchToAuto}
          </button>
        )}
      </div>
      {switchError && <div className="mt-2 text-xs text-badge-danger" role="alert">{switchError}</div>}
      {modeChange && (
        <div className="mt-2 text-xs text-zinc-500" data-testid="cron-action-mode-change">
          {copy.changeLog.replace('{time}', formatDateTime(modeChange.at))
            .replace('{from}', copy[modeChange.from])
            .replace('{to}', copy[modeChange.to])}
        </div>
      )}

      <div className="mt-3 text-xs font-medium text-zinc-300">{copy.decisionsTitle}</div>
      {loadFailed ? (
        <div className="mt-2 text-xs text-zinc-500">{copy.decisionsLoadFailed}</div>
      ) : decisions.length === 0 ? (
        <div className="mt-2 text-xs text-zinc-500">{copy.decisionsEmpty}</div>
      ) : (
        <>
          {/* 返修③：「会接单但未执行」单独一节——观察档用户要过目的行不与其余决策混排。 */}
          {wouldActRows.length > 0 && (
            <div className="mt-2" data-testid="cron-event-would-act-section">
              <div className="text-xs font-medium text-amber-500/90">{copy.wouldActSectionTitle}</div>
              <ul className="mt-1.5 space-y-1.5">
                {wouldActRows.map((row) => renderRow(row, 'cron-event-would-act-row'))}
              </ul>
            </div>
          )}
          {otherRows.length > 0 && (
            <>
              <div className="mt-3 text-xs font-medium text-zinc-400">{copy.otherDecisionsTitle}</div>
              <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto" data-testid="cron-event-decision-list">
                {otherRows.map((row) => renderRow(row, 'cron-event-decision-row'))}
              </ul>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={confirmOpen}
        variant="warning"
        title={copy.confirmTitle}
        message={copy.confirmMessage.replace('{name}', job.name)}
        confirmText={copy.confirmButton}
        cancelText={copy.cancel}
        confirmDisabled={switching}
        onConfirm={() => { void confirmSwitch(); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
};
