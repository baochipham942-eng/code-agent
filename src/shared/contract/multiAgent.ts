// ============================================================================
// Multi-Agent Types - Unified exports for multi-agent system types
// ============================================================================
//
// This file provides a single import point for multi-agent roles and workflows.

// ============================================================================
// Built-in Agent Types
// ============================================================================

export type {
  BuiltInAgentRole,
  BuiltInAgentConfig,
} from './builtInAgents';

export {
  BUILT_IN_AGENTS,
  getBuiltInAgent,
  isBuiltInAgentRole,
  listBuiltInAgentRoles,
  listBuiltInAgents,
  getBuiltInAgentsByTag,
} from './builtInAgents';

// ============================================================================
// Workflow Types
// ============================================================================

export type {
  WorkflowStage,
  WorkflowTemplate,
  StageContext,
  StageResult,
  GeneratedFile,
  WorkflowStatus,
  WorkflowExecution,
  WorkflowExecutionOptions,
  BuiltInWorkflowId,
} from './workflow';

export {
  BUILT_IN_WORKFLOWS,
  getBuiltInWorkflow,
  isBuiltInWorkflowId,
  listBuiltInWorkflowIds,
  listBuiltInWorkflows,
  getBuiltInWorkflowsByTag,
  validateWorkflowDependencies,
} from './workflow';
