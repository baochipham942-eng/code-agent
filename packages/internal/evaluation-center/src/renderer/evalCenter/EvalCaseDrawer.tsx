import React, { useEffect, useState } from 'react';
import { Clock3, X } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type { EvalExperimentCaseDetail } from '@shared/contract/evaluation';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { invokeEvaluation } from '../evaluationRunIpc';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { getEvalStatusLabel } from '../i18n/evalStatusLabels';
import { useEvalCenterStore } from '../stores/evalCenterStore';
import ipcService from '@renderer/services/ipcService';
import { Z_LAYERS } from '@renderer/styles/zLayers';
import { Badge } from '@renderer/components/primitives/Badge';
import { Button } from '@renderer/components/primitives/Button';
import { IconButton } from '@renderer/components/primitives/IconButton';
import { EvalCaseTranscript } from './EvalCaseTranscript';
import { EvalCaseChecks } from './EvalCaseChecks';
import { EvalCaseAnnotation } from './EvalCaseAnnotation';

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

type CaseStatus = EvalExperimentCaseDetail['status'];

function excludesCapabilityResult(status: CaseStatus | undefined): boolean {
  return status === 'infra_excluded'
    || status === 'invalid'
    || status === 'skipped'
    || status === 'cost_exceeded'
    || status === 'not_run';
}

export interface EvalCaseDrawerTarget {
  experimentId: string;
  caseId: string;
}

interface EvalCaseDrawerProps {
  target: EvalCaseDrawerTarget;
  onClose(): void;
}

export const EvalCaseDrawer: React.FC<EvalCaseDrawerProps> = ({ target, onClose }) => {
  const { t } = useEvaluationI18n();
  const labels = t.evalCenter.caseDrawer;
  const [detail, setDetail] = useState<EvalExperimentCaseDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [selectedTrial, setSelectedTrial] = useState(1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setLoadState('loading');
    setSelectedTrial(1);
    void invokeEvaluation(EVALUATION_CHANNELS.LOAD_CASE, target)
      .then((result) => {
        if (!active) return;
        if (!result) throw new Error(target.caseId);
        setDetail(result);
        setLoadState('ready');
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadState('error');
      });
    return () => { active = false; };
  }, [target]);

  const excluded = excludesCapabilityResult(detail?.status);
  const trials = detail?.evidence?.trialDetails ?? [];
  const selected = trials.find((trial) => trial.index === selectedTrial);
  const passedTrials = trials.filter((trial) => trial.status === 'passed').length;
  const excludedTrials = trials.filter((trial) => excludesCapabilityResult(trial.status)).length;
  const failedTrials = trials.length - passedTrials - excludedTrials;
  const reportFile = detail?.reportFiles?.find((file) => /^(?:\/|[A-Za-z]:[\\/]).+\.md$/i.test(file));

  const statusLabel = detail ? getEvalStatusLabel(detail.status, labels.status) : labels.status.failed;
  const reason = detail?.failureLabel ?? detail?.failureReason ?? statusLabel;
  const costSuffix = typeof detail?.costUsd === 'number'
    ? ` · ${fill(labels.caseCost, { cost: formatUsd(detail.costUsd) })}`
    : '';
  const conclusion = (detail?.evidence && !excluded
    ? (reason === statusLabel
      ? statusLabel
      : fill(labels.conclusion, { status: statusLabel, reason }))
    : `${statusLabel}${reason !== statusLabel ? ` · ${reason}` : ''}${excluded ? ` · ${labels.excludedShort}` : ''}`) + costSuffix;

  const editCase = () => {
    useEvalCenterStore.getState().openCase(target.caseId);
  };
  const openReport = async () => {
    if (!reportFile) return;
    await ipcService.invokeDomain(IPC_DOMAINS.WORKSPACE, 'openPath', { filePath: reportFile });
  };

  return (
    <aside
      role="dialog"
      aria-labelledby="eval-case-drawer-title"
      className="fixed inset-y-0 right-0 flex w-[560px] max-w-full flex-col border-l border-zinc-800 elevation-l2"
      style={{ zIndex: Z_LAYERS.drawer }}
      data-testid="eval-case-drawer"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div id="eval-case-drawer-title" className="truncate font-mono text-sm font-medium text-zinc-200">{target.caseId}</div>
          <div className="text-[10px] text-zinc-600">{labels.title}</div>
        </div>
        {detail && (
          <Badge className={excluded
            ? 'ml-auto border-badge-warning/30 bg-badge-warning text-badge-warning'
            : detail.status === 'passed'
              ? 'ml-auto border-badge-success/30 bg-badge-success text-badge-success'
              : 'ml-auto border-badge-danger/30 bg-badge-danger text-badge-danger'}>
            {statusLabel}
          </Badge>
        )}
        <IconButton autoFocus variant="ghost" icon={<X />} aria-label={labels.close} onClick={onClose} />
      </header>

      {loadState === 'loading' && (
        <div className="space-y-4 p-4" aria-label={labels.loading}>
          {[80, 64, 92, 72].map((width) => <div key={width} className="h-4 animate-pulse rounded bg-zinc-800" style={{ width: `${width}%` }} />)}
        </div>
      )}
      {loadState === 'error' && <p className="p-4 text-sm text-zinc-500">{fill(labels.loadFailed, { message: loadError })}</p>}
      {loadState === 'ready' && detail && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div data-testid="eval-case-conclusion" className={excluded ? 'bg-badge-warning px-4 py-3 text-sm font-medium text-badge-warning' : 'bg-[var(--bg-active)] px-4 py-3 text-sm font-medium text-zinc-200'}>
            {conclusion}
          </div>

          {trials.length > 1 && (
            <section className="border-b border-zinc-800 px-4 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {trials.map((trial) => (
                  <Button
                    key={trial.index}
                    variant="ghost"
                    size="sm"
                    aria-pressed={selectedTrial === trial.index}
                    aria-label={fill(labels.selectedAttempt, { index: trial.index, status: getEvalStatusLabel(trial.status, labels.status), score: trial.score })}
                    className={`h-7 min-w-7 px-1 ${selectedTrial === trial.index ? 'bg-[var(--bg-active)]' : ''}`}
                    onClick={() => setSelectedTrial(trial.index)}
                  >
                    {excluded || excludesCapabilityResult(trial.status)
                      ? <Clock3 className="h-3.5 w-3.5 text-badge-warning" />
                      : trial.status === 'passed' ? '✓' : '✕'}
                  </Button>
                ))}
                <span className="ml-1 text-[11px] text-zinc-500">
                  {excluded
                    ? fill(labels.excludedTrials, { total: trials.length, status: statusLabel })
                    : excludedTrials > 0
                      ? fill(labels.mixedTrials, {
                        total: trials.length,
                        passed: passedTrials,
                        failed: failedTrials,
                        excluded: excludedTrials,
                        judgement: detail.status === 'passed' ? labels.judgedPassed : labels.judgedFailed,
                      })
                      : fill(labels.unstable, { total: trials.length, passed: passedTrials, failed: failedTrials })}
                </span>
              </div>
              {selected && !excluded && <div className="mt-2 text-[10px] text-zinc-600">{fill(labels.selectedAttempt, { index: selected.index, status: getEvalStatusLabel(selected.status, labels.status), score: selected.score })}</div>}
            </section>
          )}

          <section className="border-b border-zinc-800 px-4 py-4">
            <h3 className="mb-1 text-xs font-medium text-zinc-300">{labels.conversation}</h3>
            {trials.length > 1 && (
              <p className="mb-3 text-[10px] text-zinc-600">{labels.representativeAttempt}</p>
            )}
            <EvalCaseTranscript evidence={detail.evidence} promptVersion={detail.promptVersion} labels={labels} />
          </section>

          <section className="border-b border-zinc-800 px-4 py-4">
            <h3 className="mb-3 text-xs font-medium text-zinc-300">{labels.checks}</h3>
            <EvalCaseChecks
              detail={detail}
              labels={labels}
              aiDimensionLabels={t.evalCenter.runPanel.aiReviewDimensions}
              excluded={excluded}
              excludedStatusLabel={statusLabel}
            />
          </section>

          <EvalCaseAnnotation target={target} />

          <section className="px-4 py-4">
            <h3 className="mb-3 text-xs font-medium text-zinc-300">{labels.source}</h3>
            {detail.caseMetadata && (
              <div className="mb-3 flex flex-wrap gap-1.5 text-[10px]">
                {detail.caseMetadata.type && <Badge className="border-zinc-700 text-zinc-400">{detail.caseMetadata.type}</Badge>}
                {detail.caseMetadata.category && <Badge className="border-zinc-700 text-zinc-400">{detail.caseMetadata.category}</Badge>}
                {detail.caseMetadata.tags.map((tag) => <Badge key={tag} className="border-zinc-700 text-zinc-500">{tag}</Badge>)}
                {detail.caseMetadata.splits.filter((split) => split !== 'control').map((split) => (
                  <Badge key={split} className="border-badge-info/30 text-badge-info">
                    {split === 'held-in' ? labels.dailySet : split === 'held-out' ? labels.heldOutSet : labels.safetySet}
                  </Badge>
                ))}
                <Badge className="border-zinc-700 text-zinc-500">
                  {detail.caseMetadata.source === 'session' ? labels.sourceSession : labels.sourceManual}
                </Badge>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {reportFile && <Button size="sm" variant="secondary" onClick={() => void openReport()}>{labels.openReport}</Button>}
              <Button size="sm" variant="secondary" onClick={editCase}>{labels.editCase}</Button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
};
