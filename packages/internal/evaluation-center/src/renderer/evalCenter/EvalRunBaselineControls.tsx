import React from 'react';
import { Button } from '@renderer/components/primitives/Button';
import type { EvalBaselineInfo } from '@shared/contract/evaluationBaseline';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';
import { useRunConfirmation } from './useRunConfirmation';

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export const EvalRunBaselineHeader: React.FC<{
  title: string;
  runCount: number;
  baseline?: EvalBaselineInfo;
  labels: EvalRunPanelLabels;
  language: 'zh' | 'en';
}> = ({ title, runCount, baseline, labels, language }) => (
  <div className="bg-zinc-800/70 px-3 py-2 text-xs text-zinc-300">
    <div className="flex items-center gap-2">
      <span className="font-medium">{title}</span>
      <span className="text-zinc-500">
        {baseline
          ? replace(labels.comparisonReferenceAt, {
            time: new Date(baseline.updatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'),
          })
          : labels.noComparisonReference}
      </span>
      <span className="ml-auto text-zinc-500">{replace(labels.runs, { count: runCount })}</span>
    </div>
    {baseline?.divergesFromProduction && (
      <div className="mt-1 text-zinc-500">
        <span className="mr-2 rounded bg-zinc-700 px-1.5 py-0.5">{labels.productionDifferent}</span>
        {baseline.productionDifferences.join(' · ')}
      </div>
    )}
  </div>
);

export const EvalRunBaselineControls: React.FC<{
  current: boolean;
  disabledReason?: string;
  labels: EvalRunPanelLabels;
  onSet(): void;
}> = ({ current, disabledReason, labels, onSet }) => {
  const confirmation = useRunConfirmation(onSet);
  if (current) return <span className="w-48 shrink-0 text-right text-zinc-500">{labels.currentComparisonReference}</span>;
  return (
    <span className="flex w-48 shrink-0 flex-col items-end gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        disabled={Boolean(disabledReason)}
        onClick={confirmation.trigger}
      >
        {confirmation.confirmArmed ? labels.confirmComparisonReference : labels.setComparisonReference}
      </Button>
      {disabledReason && <span className="text-[11px] text-zinc-600">{disabledReason}</span>}
    </span>
  );
};
