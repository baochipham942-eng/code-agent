export { runRegression, decideGate, filterCasesByCategory, runOne, type RunOptions } from './regressionRunner';
export { runRegressionParallel, pLimit, type ParallelRunOptions } from './parallelRegressionRunner';
export { getOrRun, computeCacheHash, defaultCacheDir, type CacheOptions } from './regressionCache';
export { loadAllCases, loadCase } from './caseLoader';
export { readBaseline, writeBaseline } from './baselineStore';
export type {
  RegressionCase,
  CaseResult,
  RegressionReport,
  Baseline,
  GateDecision,
} from './regressionTypes';
