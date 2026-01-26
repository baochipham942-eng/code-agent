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

// Agent Bus (Gen7 - Multi-Agent Communication)
export {
  getAgentBus,
  initAgentBus,
  resetAgentBus,
  AgentBus,
  type AgentMessage,
  type MessageType,
  type MessagePriority,
  type MessageSubscriber,
  type SharedStateEntry,
  type StateChangeEvent,
  type AgentBusConfig,
} from './agentBus';

// Dynamic Coordinator (Gen7 - Dynamic Multi-Agent Orchestration)
export {
  getDynamicCoordinator,
  initDynamicCoordinator,
  resetDynamicCoordinator,
  DynamicCoordinator,
  type AgentRuntimeState,
  type CoordinationResult,
  type CoordinatorContext,
  type DynamicCoordinatorConfig,
} from './dynamicCoordinator';

// Parallel Agent Coordinator
export {
  getParallelAgentCoordinator,
  initParallelAgentCoordinator,
  ParallelAgentCoordinator,
  type AgentTask as ParallelAgentTask,
  type AgentTaskResult,
  type ParallelExecutionResult,
  type SharedContext,
  type CoordinatorConfig,
} from './parallelAgentCoordinator';

// Auto Agent Coordinator
export {
  getAutoAgentCoordinator,
  AutoAgentCoordinator,
  type AgentExecutionStatus,
  type AgentExecutionResult,
  type CoordinationResult as AutoCoordinationResult,
} from './autoAgentCoordinator';

// Resource Lock Manager
export {
  getResourceLockManager,
  ResourceLockManager,
  type ResourceLock,
  type LockAcquisitionResult,
  type ResourceConflict,
  ConflictResolution,
} from './resourceLockManager';

// Progress Aggregator
export {
  getProgressAggregator,
  createProgressAggregator,
  ProgressAggregator,
  type AgentProgress,
  type AggregatedProgress,
  type ProgressUpdateEvent,
} from './progressAggregator';

// Dynamic Agent Factory
export {
  getDynamicAgentFactory,
  DynamicAgentFactory,
  type DynamicAgentDefinition,
  type FactoryContext,
} from './dynamicAgentFactory';

// Agent Requirements Analyzer
export {
  getAgentRequirementsAnalyzer,
  AgentRequirementsAnalyzer,
  type AgentTaskType,
  type ExecutionStrategy,
  type AgentRequirements,
  type SuggestedAgents,
  type ToolConstraints,
} from './agentRequirementsAnalyzer';

// Built-in Agent Types (Architecture Evolution)
export {
  BUILTIN_AGENTS,
  AGENT_PARALLEL_CONFIG,
  EFFORT_CONFIG,
  getBuiltinAgent,
  listBuiltinAgents,
  getAgentsByLayer,
  canAgentsRunInParallel,
  getAgentModelConfig,
  getAgentTools,
  type BuiltinAgentConfig,
  type AgentLayer,
  type ParallelCapability,
  type EffortLevel,
} from './types/builtinAgents';

// Existing exports (re-export for convenience)
export { AgentOrchestrator, type AgentOrchestratorConfig } from './agentOrchestrator';
export { AgentLoop } from './agentLoop';
export { getSubagentExecutor, SubagentExecutor, type SubagentConfig, type SubagentResult as SubagentExecutorResult } from './subagentExecutor';
