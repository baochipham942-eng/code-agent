import React from 'react';
import { Check, Circle, Square } from 'lucide-react';
import type { EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import type { EvalRunPanelLabels } from '../../../i18n/evalRunPanel';
import { Button } from '../../primitives/Button';
import { Modal } from '../../primitives/Modal';

export type EvalRunSplit = Extract<NonNullable<EvalRunRequest['split']>, 'held-in' | 'held-out' | 'safety'>;

const TAG_OPTIONS = [
  { id: 'core-path', labelKey: 'tagCorePath' },
  { id: 'recovery', labelKey: 'tagRecovery' },
  { id: 'conversation', labelKey: 'tagConversation' },
  { id: 'multi-turn', labelKey: 'tagMultiTurn' },
  { id: 'spreadsheet', labelKey: 'tagSpreadsheet' },
  { id: 'web', labelKey: 'tagWeb' },
] as const;

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
  labels: EvalRunPanelLabels;
  onClose(): void;
  onSplit(split: EvalRunSplit): void;
  onToggleTag(tag: string): void;
  onMaxCases(value: number): void;
  onRun(): void;
}

export const EvalRunWizard: React.FC<EvalRunWizardProps> = ({
  open, probe, split, tags, maxCases, confirmArmed, starting, estimatedCost,
  labels, onClose, onSplit, onToggleTag, onMaxCases, onRun,
}) => {
  const safetyAvailable = probe?.environment.osJail.active === true;
  const footer = (
    <div className="flex w-full items-center gap-3 bg-badge-warning px-4 py-3">
      <span className="text-xs text-badge-warning">
        <span className="block">
          {replace(labels.estimatedCost, {
            cost: formatUsd(estimatedCost),
            version: probe?.priceTableVersion ?? '—',
          })}
        </span>
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
        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.datasetSection}</h3>
          <div className="space-y-2">
            {([
              ['held-in', labels.dailySet],
              ['held-out', labels.heldOutSet],
              ['safety', labels.safetySet],
            ] as const).map(([value, label]) => {
              const disabled = value === 'safety' && !safetyAvailable;
              return (
                <button /* ds-allow:button: 评测集单选卡片，Button primitive 无整行 radio card 变体 */
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSplit(value)}
                  className={`flex w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left text-xs ${split === value ? 'ring-1 ring-zinc-500' : ''} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Circle className={`h-3 w-3 ${split === value ? 'fill-zinc-300 text-zinc-300' : 'text-zinc-600'}`} />
                  <span className="text-zinc-200">{label}</span>
                  <span className="ml-auto text-zinc-500">{probe?.splitCounts[value] ?? '—'}</span>
                </button>
              );
            })}
          </div>
          {!safetyAvailable && <p className="mt-2 text-xs text-zinc-500">{labels.safetyUnavailable}</p>}
          <div className="mt-4">
            <div className="mb-2 text-xs text-zinc-400">{labels.tags}</div>
            <div className="flex flex-wrap gap-1.5">
              {TAG_OPTIONS.map((option) => (
                <button /* ds-allow:button: 标签 chip 多选，Button primitive 的 padding/圆角密度不适用 */
                  key={option.id}
                  type="button"
                  aria-pressed={tags.includes(option.id)}
                  onClick={() => onToggleTag(option.id)}
                  className={`rounded-full px-2 py-1 text-xs ${tags.includes(option.id) ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-500'}`}
                >
                  {labels[option.labelKey]}
                </button>
              ))}
            </div>
          </div>
          <label className="mt-4 block text-xs text-zinc-400">
            {labels.maxCases}
            <input
              type="number"
              min={1}
              max={probe?.splitCounts[split] ?? 500}
              value={maxCases}
              onChange={(event) => onMaxCases(Math.max(1, Number(event.target.value) || 1))}
              className="mt-1 w-full rounded-lg bg-zinc-800 px-3 py-2 text-zinc-200 outline-hidden ring-1 ring-zinc-700 focus:ring-accent-accessible"
            />
          </label>
          {maxCases > 50 && <p className="mt-2 text-xs text-badge-warning">{labels.expensiveHint}</p>}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.shapeSection}</h3>
          <div className="rounded-lg bg-zinc-800 p-3 text-xs leading-5 text-zinc-400">
            {labels.productionShape}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.scorerSection}</h3>
          <div className="flex items-start gap-2 rounded-lg bg-zinc-800 p-3 text-xs">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-zinc-700 text-zinc-100">
              <Check className="h-3 w-3" />
            </span>
            <span>
              <span className="block text-zinc-200">{labels.deterministicScorer}</span>
              <span className="text-zinc-500">{labels.locked}</span>
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-800/60 p-3 text-xs text-zinc-600" aria-disabled="true">
            <Square className="h-4 w-4" />
            <span>{labels.aiJudge}</span>
            <span className="ml-auto">{labels.nextVersion}</span>
          </div>
        </section>
      </div>
    </Modal>
  );
};
