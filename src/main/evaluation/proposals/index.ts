// ============================================================================
// Proposals — Barrel Export
// Self-Evolving v2.5 Phase 3
// ============================================================================

export type {
  Proposal,
  ProposalStatus,
  ProposalType,
  ShadowEvalResult,
} from './proposalTypes';

export {
  loadProposal,
  loadAllProposals,
  writeProposal,
  updateStatus,
  generateProposalId,
  defaultProposalsDir,
  findSimilarProposal,
  appendEvidenceToProposal,
  type EvidenceItem,
} from './proposalStore';

export {
  ShadowEvaluator,
  scanConflictsInDir,
  defaultConflictDirs,
  readAttributionCategoriesFromDir,
  defaultGraderReportsDir,
  type ShadowEvaluatorDeps,
} from './shadowEvaluator';

export {
  applyProposal,
  defaultExperimentsDir,
  type ApplyOptions,
  type ApplyResult,
} from './proposalApplier';

export { runRegressionGateViaCli } from './regressionGateAdapter';

export {
  polishRecipe,
  buildPrompt as buildPolishPrompt,
  type ChatFn as PolishChatFn,
  type StaticRecipe,
  type RecipePolishInput,
  type PolishedRecipe,
} from './recipePolisher';
