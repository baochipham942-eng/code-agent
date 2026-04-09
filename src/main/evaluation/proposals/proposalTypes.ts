// ============================================================================
// Proposal Types — Self-Evolving v2.5 Phase 3
// ============================================================================

export type ProposalStatus =
  | 'pending'
  | 'shadow_passed'
  | 'shadow_failed'
  | 'needs_human'
  | 'applied'
  | 'rejected'
  | 'superseded';

export type ProposalType =
  | 'new_l3_experiment'
  | 'promote_l3_to_l2'
  | 'archive_expired'
  | 'merge_rules';

export interface ShadowEvalResult {
  evaluatedAt: string;               // ISO8601
  conflictsWith: string[];           // file paths or identifiers
  addressesCategories: Array<{
    category: string;                // FailureCategory from Phase 2
    hits: number;
  }>;
  regressionGateDecision: 'pass' | 'block' | 'skipped';
  score: number;                     // 0-1
  recommendation: 'apply' | 'reject' | 'needs_human';
  reason: string;
}

export interface Proposal {
  id: string;                        // prop-YYYYMMDD-NNN
  filePath: string;
  createdAt: string;                 // ISO8601
  status: ProposalStatus;
  source: 'synthesize' | 'manual';
  type: ProposalType;

  // Content
  ruleId?: string;
  ruleContent?: string;
  hypothesis: string;
  targetMetric: string;
  rollbackCondition: string;
  tags: string[];
  sunset?: string;                   // YYYY-MM-DD

  // Shadow eval result (filled after evaluate)
  shadowEval?: ShadowEvalResult;
}
