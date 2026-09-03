import type {
  EvalExperimentListItem,
  EvalRunStamp,
} from './evaluation';

export type EvalBaselineSplit = 'held-in' | 'held-out' | 'safety' | 'all';
export type RunShape = EvalRunStamp['shape'];
export type EvalBaselineGroupKey = `${EvalBaselineSplit}::${number}`;

export interface EvalBaselineCaseResult {
  status: string;
  score: number;
  costUsd?: number;
}

export interface EvalBaselineInfo {
  experimentId?: string;
  updatedAt: number;
  updatedBy: string;
  commit: string;
  caseBankSha: string;
  aggregationRuleVersion: number;
  denominatorVersion: number;
  divergesFromProduction: boolean;
  productionDifferences: string[];
  shape?: RunShape;
  plannedCaseIds: string[];
  caseResults: Record<string, EvalBaselineCaseResult>;
}

export interface EvalBaselineInfoResult {
  groups: Partial<Record<EvalBaselineGroupKey, EvalBaselineInfo>>;
}

export type EvalBaselineSetError =
  | 'baseline_incomplete'
  | 'baseline_invalid_run'
  | 'baseline_not_real'
  | 'baseline_legacy_run';

export type EvalBaselineSetResult =
  | { baseline: EvalBaselineInfo }
  | { error: EvalBaselineSetError };

export type EvalBaselineExperimentListItem = EvalExperimentListItem & {
  caseResults?: Record<string, EvalBaselineCaseResult>;
};
