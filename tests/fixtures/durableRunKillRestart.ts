import type { PendingOperationKind, RunEngineRef } from '../../src/shared/contract/durableRun';

export type DurableRunExpectedOutcome = 'completed' | 'observing' | 'waiting_review' | 'waiting_approval';

export interface DurableRunKillRestartScenario {
  id: string;
  coreId:
    | 'before-model-dispatch'
    | 'after-model-response'
    | 'between-tool-begin-end'
    | 'approval-waiting'
    | 'child-agent-running'
    | 'dynamic-workflow'
    | 'agent-team-auto-agent'
    | 'external-engine'
    | 'mcp-durable-task';
  killPoint: string;
  engine: RunEngineRef;
  operationKind: PendingOperationKind;
  operationStatus: 'prepared' | 'dispatched' | 'waiting';
  sideEffect: boolean;
  providerOperationId?: string;
  expectedOutcome: DurableRunExpectedOutcome;
  expectedRecoveryAction: string;
  requiresReviewReason?: string;
}

/** Real child-process acceptance matrix. Variants cover both safe and uncertain recovery branches. */
export const DURABLE_RUN_KILL_RESTART_SCENARIOS: readonly DurableRunKillRestartScenario[] = [
  {
    id: 'before-model-dispatch', coreId: 'before-model-dispatch',
    killPoint: 'prepared checkpoint committed before provider dispatch', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'prepared', sideEffect: false,
    expectedOutcome: 'completed', expectedRecoveryAction: 'execute_prepared_model_once',
  },
  {
    id: 'after-model-response-queryable', coreId: 'after-model-response',
    killPoint: 'provider response returned before result checkpoint', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'dispatched', sideEffect: false,
    providerOperationId: 'model-response:queryable', expectedOutcome: 'completed',
    expectedRecoveryAction: 'query_original_model_result',
  },
  {
    id: 'after-model-response-safe-retry', coreId: 'after-model-response',
    killPoint: 'unqueryable safe compute response before result checkpoint', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'dispatched', sideEffect: false,
    expectedOutcome: 'completed', expectedRecoveryAction: 'retry_safe_model_compute_once',
  },
  {
    id: 'between-tool-begin-end-deduplicated', coreId: 'between-tool-begin-end',
    killPoint: 'tool begin/end with provider dedupe evidence', engine: { kind: 'native' },
    operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'tool-op:confirmed', expectedOutcome: 'completed',
    expectedRecoveryAction: 'query_confirmed_tool_result',
  },
  {
    id: 'between-tool-begin-end-unknown-write', coreId: 'between-tool-begin-end',
    killPoint: 'tool begin/end with unknown write side effect', engine: { kind: 'native' },
    operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    expectedOutcome: 'waiting_review', expectedRecoveryAction: 'require_review_without_replay',
    requiresReviewReason: 'unknown_write_side_effect',
  },
  {
    id: 'approval-waiting', coreId: 'approval-waiting', killPoint: 'approval waiting',
    engine: { kind: 'native' }, operationKind: 'approval', operationStatus: 'waiting', sideEffect: false,
    providerOperationId: 'approval:stable-1', expectedOutcome: 'waiting_approval',
    expectedRecoveryAction: 'restore_same_approval',
  },
  {
    id: 'child-agent-running', coreId: 'child-agent-running', killPoint: 'child agent running',
    engine: { kind: 'agent_team', treeId: 'team-run-stable' }, operationKind: 'child_run',
    operationStatus: 'dispatched', sideEffect: true,
    expectedOutcome: 'waiting_review', expectedRecoveryAction: 'reconcile_child_before_schedule',
    requiresReviewReason: 'requires_review',
  },
  {
    id: 'dynamic-workflow', coreId: 'dynamic-workflow', killPoint: 'nested node checkpoint committed',
    engine: { kind: 'dynamic_workflow', workflowId: 'workflow-stable' }, operationKind: 'child_run',
    operationStatus: 'prepared', sideEffect: false, expectedOutcome: 'completed',
    expectedRecoveryAction: 'resume_incomplete_nested_node',
  },
  {
    id: 'dynamic-workflow-drift', coreId: 'dynamic-workflow', killPoint: 'nested checkpoint with workspace drift',
    engine: { kind: 'dynamic_workflow', workflowId: 'workflow-drift' }, operationKind: 'child_run',
    operationStatus: 'prepared', sideEffect: false, expectedOutcome: 'waiting_review',
    expectedRecoveryAction: 'reject_drifted_workflow', requiresReviewReason: 'workspace_model_tool_drift',
  },
  {
    id: 'agent-team-auto-agent', coreId: 'agent-team-auto-agent', killPoint: 'graph node checkpoint committed',
    engine: { kind: 'agent_team', treeId: 'team-graph-stable' }, operationKind: 'child_run',
    operationStatus: 'prepared', sideEffect: false, expectedOutcome: 'completed',
    expectedRecoveryAction: 'resume_via_graph_compatibility_sink',
  },
  {
    id: 'external-engine-resumable', coreId: 'external-engine', killPoint: 'fake CLI session running',
    engine: { kind: 'external_cli', engine: 'codex_cli', externalSessionId: 'fake-cli-session-stable' },
    operationKind: 'external_engine', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'external-session:fake-cli-session-stable', expectedOutcome: 'completed',
    expectedRecoveryAction: 'resume_stable_external_session',
  },
  {
    id: 'external-engine-non-resumable', coreId: 'external-engine', killPoint: 'unknown external capability',
    engine: { kind: 'external_cli', engine: 'kimi_code' }, operationKind: 'external_engine',
    operationStatus: 'dispatched', sideEffect: true, expectedOutcome: 'waiting_review',
    expectedRecoveryAction: 'reject_non_resumable_external_engine', requiresReviewReason: 'resume_evidence_incomplete',
  },
  {
    id: 'mcp-durable-task-queryable', coreId: 'mcp-durable-task', killPoint: 'MCP task provider handle persisted',
    engine: { kind: 'native' }, operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'mcp-task:v1:placeholder', expectedOutcome: 'observing',
    expectedRecoveryAction: 'query_mcp_provider_handle',
  },
  {
    id: 'mcp-durable-task-unknown', coreId: 'mcp-durable-task', killPoint: 'MCP handle missing',
    engine: { kind: 'native' }, operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'mcp-task:v1:invalid',
    expectedOutcome: 'waiting_review', expectedRecoveryAction: 'reject_unknown_mcp_side_effect',
    requiresReviewReason: 'task handle is invalid',
  },
] as const;
