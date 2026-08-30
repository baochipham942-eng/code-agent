import React from 'react';
import { Circle } from 'lucide-react';
import type { EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';

type EvalCaseSelectionSplit = Extract<NonNullable<EvalRunRequest['split']>, 'held-in' | 'held-out' | 'safety'>;

const TAG_OPTIONS = [
  { id: 'core-path', labelKey: 'tagCorePath' },
  { id: 'recovery', labelKey: 'tagRecovery' },
  { id: 'conversation', labelKey: 'tagConversation' },
  { id: 'multi-turn', labelKey: 'tagMultiTurn' },
  { id: 'spreadsheet', labelKey: 'tagSpreadsheet' },
  { id: 'web', labelKey: 'tagWeb' },
] as const;

export const EvalCaseSelectionFields: React.FC<{
  probe: EvalRunPanelProbe | null;
  split: EvalCaseSelectionSplit;
  tags: string[];
  maxCases: number;
  labels: EvalRunPanelLabels;
  onSplit(split: EvalCaseSelectionSplit): void;
  onToggleTag(tag: string): void;
  onMaxCases(value: number): void;
}> = ({ probe, split, tags, maxCases, labels, onSplit, onToggleTag, onMaxCases }) => {
  const safetyAvailable = probe?.environment.osJail.active === true;

  return (
    <section data-testid="eval-case-selection-fields">
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
      {(probe?.unhardenedCount ?? 0) > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {labels.unhardenedNotice.replace('{n}', String(probe?.unhardenedCount))}
        </p>
      )}
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
  );
};
