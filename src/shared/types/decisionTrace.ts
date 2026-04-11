// ============================================================================
// Decision Trace Types - Security decision chain transparency
// ============================================================================

export type DecisionLayer =
  | 'policy_enforcer'
  | 'guard_fabric'
  | 'permission_classifier'
  | 'plan_approval'
  | 'plugin_hook';

export type DecisionOutcome = 'allow' | 'deny' | 'ask';

export interface DecisionStep {
  layer: DecisionLayer;
  rule: string;
  result: DecisionOutcome;
  reason: string;
  durationMs: number;
  timestamp: number;
}

export interface DecisionTrace {
  toolName: string;
  finalOutcome: DecisionOutcome;
  steps: DecisionStep[];
  totalDurationMs: number;
}
