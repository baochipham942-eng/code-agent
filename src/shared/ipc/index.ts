// ============================================================================
// IPC Module Exports (barrel re-export)
// ============================================================================

// Re-export context health types for consumer convenience
export type { ContextHealthState, ContextHealthUpdateEvent } from '../types/contextHealth';

// Re-export session state types for consumer convenience
export type {
  SessionStatus,
  SubagentState,
  SessionRuntimeSummary,
  SessionStatusUpdateEvent,
} from '../types/sessionState';

// Sub-modules
export * from './types';
export * from './domains';
export * from './legacy-channels';
export * from './handlers';
export * from './api';
export * from './channels';
export * from './protocol';
