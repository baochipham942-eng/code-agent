// ============================================================================
// Hooks Module - Dual-channel hooks system exports
// ============================================================================

// Types
export * from './types';

// Matchers (re-export from parent for convenience)
export { matchers, matchTool, matchCategory } from '../matchers';

// Observer Hooks
export {
  observerHooks,
  getObserversForPoint,
  resetObserverState,
  getActionCount,
  getToolUsageStats,
  toolUsageLogger,
  actionCounter,
  actionCounterReset,
  errorStatisticsObserver,
  criticalToolMonitor,
  sessionActivityTracker,
} from './observerHooks';

// Decision Hooks
export {
  createDecisionHooks,
  getDecisionHooksForPoint,
  type DecisionHooksConfig,
} from './decisionHooks';
