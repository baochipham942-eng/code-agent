import React from 'react';
import { Check, Square } from 'lucide-react';
import type { EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import type { AiReviewDimension } from '@shared/contract/evaluation';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';
import { Button } from '@renderer/components/primitives/Button';
import { Modal } from '@renderer/components/primitives/Modal';
import { EvalCaseSelectionFields } from './EvalCaseSelectionFields';

export type EvalRunSplit = Extract<NonNullable<EvalRunRequest['split']>, 'held-in' | 'held-out' | 'safety'>;

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? '--' : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

interface EvalRunWizardProps {
  open: boolean;
  probe: EvalRunPanelProbe | null;
  split: EvalRunSplit;
  tags: string[];
  maxCases: number;
  confirmArmed: boolean;
  starting: boolean;
  estimatedCost?: number;
  aiReviewEstimatedCost?: number;
  selectedAiReview: AiReviewDimension[];
  labels: EvalRunPanelLabels;
  onClose(): void;
  onSplit(split: EvalRunSplit): void;
  onToggleTag(tag: string): void;
  onMaxCases(value: number): void;
  onToggleAiReview(dimension: AiReviewDimension): void;
  onRun(): void;
}

export const EvalRunWizard: React.FC<EvalRunWizardProps> = ({
  open, probe, split, tags, maxCases, confirmArmed, starting, estimatedCost,
  aiReviewEstimatedCost, selectedAiReview, labels, onClose, onSplit, onToggleTag,
  onMaxCases, onToggleAiReview, onRun,
}) => {
  const footer = (
    <div className="flex w-full items-center gap-3 bg-badge-warning px-4 py-3">
      <span className="text-xs text-badge-warning">
        <span className="block">
          {replace(labels.estimatedCost, {
            cost: formatUsd(estimatedCost),
            version: probe?.priceTableVersion ?? '—',
          })}
        </span>
        {selectedAiReview.length > 0 && (
          <span className="mt-0.5 block text-[10px]" data-testid="eval-ai-review-cost">
            {replace(labels.aiReviewEstimatedCost, {
              cost: formatUsd(aiReviewEstimatedCost), count: maxCases, k: 1,
              dimensions: selectedAiReview.length, model: probe?.judge.model ?? 'unknown',
            })}
          </span>
        )}
        {confirmArmed && <span className="mt-0.5 block text-[10px]">{labels.confirmSafety}</span>}
      </span>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose} disabled={starting}>
        {labels.cancel}
      </Button>
      <Button
        variant={confirmArmed ? 'secondary' : 'primary'}
        size="sm"
        style={confirmArmed ? { background: 'var(--badge-warning-fg)', color: 'var(--text-inverse)' } : undefined}
        loading={starting}
        onClick={onRun}
        data-testid="eval-run-confirm"
      >
        {starting
          ? labels.starting
          : confirmArmed
            ? replace(labels.confirmRun, {
              model: probe?.model ?? 'unknown',
              count: maxCases,
              cost: formatUsd(estimatedCost),
            })
            : labels.runAndBill}
      </Button>
    </div>
  );

  return (
    <Modal isOpen={open} onClose={onClose} title={labels.wizardTitle} size="full" footer={footer} portal>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <EvalCaseSelectionFields
          probe={probe}
          split={split}
          tags={tags}
          maxCases={maxCases}
          labels={labels}
          onSplit={onSplit}
          onToggleTag={onToggleTag}
          onMaxCases={onMaxCases}
        />

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.shapeSection}</h3>
          <div className="rounded-lg bg-zinc-800 p-3 text-xs leading-5 text-zinc-400">
            {labels.productionShape}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.scorerSection}</h3>
          <p className="mb-2 text-xs text-zinc-500">{labels.aiReviewColumns}</p>
          <div className="flex items-start gap-2 rounded-lg bg-zinc-800 p-3 text-xs">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-zinc-700 text-zinc-100">
              <Check className="h-3 w-3" />
            </span>
            <span>
              <span className="block text-zinc-200">{labels.deterministicScorer}</span>
              <span className="text-zinc-500">{labels.locked}</span>
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {(probe?.aiReview ?? []).map(({ dim, calibration, requiresExpectation }) => {
              const selected = selectedAiReview.includes(dim);
              const calibrated = calibration.state === 'calibrated';
              const disabled = requiresExpectation;
              const reason = calibration.reason ? labels.calibrationReasons[calibration.reason] : '';
              return (
                <div key={dim}>
                  <button /* ds-allow:button: checkbox 整行包含校准状态，Button primitive 不承载此复合选择语义 */
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => onToggleAiReview(dim)}
                    className="flex w-full items-center gap-2 rounded-lg bg-zinc-800 p-3 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`eval-ai-review-toggle-${dim}`}
                  >
                    {selected ? <Check className="h-4 w-4 text-zinc-200" /> : <Square className="h-4 w-4 text-zinc-500" />}
                    <span className="text-zinc-200">
                      <span className="block">{labels.aiReviewDimensions[dim]}</span>
                      <span className="text-zinc-500">{labels.aiJudge} · 是 / 否</span>
                    </span>
                    <span className={`ml-auto rounded px-1.5 py-0.5 ${calibrated ? 'text-badge-success' : 'text-badge-warning'}`}>
                      {calibrated
                        ? replace(labels.calibrated, { kappa: calibration.kappa?.toFixed(2) ?? '—', pairs: calibration.pairs ?? 0 })
                        : `${labels.uncalibrated} · ${reason}`}
                    </span>
                  </button>
                  {disabled && <p className="mt-1 px-3 text-[10px] text-zinc-500">{labels.needsExpectation}</p>}
                  {selected && !calibrated && <p className="mt-1 px-3 text-[10px] text-badge-warning">{labels.referenceOnly}</p>}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Modal>
  );
};
