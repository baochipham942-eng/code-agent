// ============================================================================
// Agent Module - Agent types, delegation, persistence, and permissions
// ============================================================================

// Core Agent Types
export {
  getAgentRegistry,
  resetAgentRegistry,
  AgentRegistry,
  BUILT_IN_AGENTS,
  type AgentDefinition,
  type AgentInstance,
  type AgentInstanceState,
  type AgentTask,
  type AgentCapability,
  type AgentPriority,
  type AgentExecutionMode,
  type PermissionConstraints,
  type SubagentResult,
} from './types';

// Auto Delegation
export {
  getAutoDelegator,
  resetAutoDelegator,
  suggestDelegation,
  AutoDelegator,
  type TaskAnalysis,
  type TaskType,
  type DelegationSuggestion,
  type DelegationResult,
} from './autoDelegator';

// Session Persistence
export {
  getSessionPersistence,
  resetSessionPersistence,
  SessionPersistence,
  type PersistedSession,
  type PersistedAgentInstance,
  type ToolCallRecord,
  type SessionIndexEntry,
} from './sessionPersistence';

// Session Resume
export {
  getSessionResume,
  resetSessionResume,
  resumeSession,
  resumeLatestSession,
  SessionResume,
  type ResumeOptions,
  type ResumeResult,
  type RestoredSession,
  type SessionListItem,
} from './resume';

// Sub-Agent Permissions
export {
  getSubAgentPermissionManager,
  resetSubAgentPermissionManager,
  evaluateSubAgentPermission,
  createSubAgentConstraints,
  SubAgentPermissionManager,
  type SubAgentPermissionResult,
  type SubAgentPermissionContext,
  type ContractionRule,
} from './permissions';

// Existing exports (re-export for convenience)
export { AgentOrchestrator, type AgentOrchestratorConfig } from './agentOrchestrator';
export { AgentLoop } from './agentLoop';
export { getSubagentExecutor, SubagentExecutor, type SubagentConfig, type SubagentResult as SubagentExecutorResult } from './subagentExecutor';
