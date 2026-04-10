// ============================================================================
// Evidence Graph — barrel export
// ============================================================================

export { EVIDENCE_GRAPH_SCHEMA } from './schema';
export { EvidenceDb, DEFAULT_DB_PATH } from './evidenceDb';
export {
  getRuleCoverage,
  getCategoryImpact,
  getRuleEvolution,
  getRuleEffectiveness,
  getSummary,
} from './evidenceQueries';
export type {
  RuleCoverageResult,
  CategoryImpactResult,
  RuleEvolutionResult,
  RuleEffectivenessResult,
  CategorySnapshot,
  SummaryResult,
} from './evidenceQueries';
