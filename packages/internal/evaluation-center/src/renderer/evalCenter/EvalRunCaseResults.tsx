import React from 'react';
import type { EvalBaselineCaseResult } from '@shared/contract/evaluationBaseline';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';
import { getEvalStatusLabel, type EvalDisplayStatus } from '../i18n/evalStatusLabels';
import { Button } from '@renderer/components/primitives/Button';

interface EvalRunCaseResultsProps {
  runId: string;
  caseResults: Record<string, EvalBaselineCaseResult> | undefined;
  labels: EvalRunPanelLabels;
  onOpenCase(caseId: string): void;
}

function displayStatus(status: string): EvalDisplayStatus {
  switch (status) {
    case 'pending':
    case 'running':
    case 'passed':
    case 'failed':
    case 'skipped':
    case 'partial':
    case 'infra_excluded':
    case 'invalid':
    case 'cost_exceeded':
    case 'not_run':
    case 'error':
      return status;
    default:
      return 'error';
  }
}

function statusClassName(status: EvalDisplayStatus): string {
  if (status === 'passed') return 'text-badge-success';
  if (status === 'failed' || status === 'error') return 'text-badge-danger';
  return 'text-zinc-500';
}

export const EvalRunCaseResults: React.FC<EvalRunCaseResultsProps> = ({
  runId, caseResults, labels, onOpenCase,
}) => {
  const cases = Object.entries(caseResults ?? {});

  return (
    <div className="border-t border-zinc-800 px-3 py-3">
      <ul className="space-y-1 text-xs">
        {cases.map(([caseId, result]) => {
          const status = displayStatus(result.status);
          return (
            <li key={caseId} data-testid={`benchmark-run-case-${runId}-${caseId}`}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-left"
                onClick={() => onOpenCase(caseId)}
              >
                <span className={statusClassName(status)}>
                  {getEvalStatusLabel(status, labels.runCaseStatus)}
                </span>
                <span className="font-mono text-zinc-300">{caseId}</span>
                <span className="text-zinc-500">
                  {labels.runCaseScore.replace('{score}', String(result.score))}
                </span>
              </Button>
            </li>
          );
        })}
        {cases.length === 0 && (
          <li className="rounded bg-zinc-800 px-2 py-1 text-zinc-500">
            {labels.noRunCases}
          </li>
        )}
      </ul>
    </div>
  );
};
