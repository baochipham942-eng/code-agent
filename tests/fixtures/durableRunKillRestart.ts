import type { PendingOperationKind, RunEngineRef } from '../../src/shared/contract/durableRun';

export type DurableRunExpectedOutcome =
  | 'completed'
  | 'observing'
  | 'running'
  | 'waiting_review'
  | 'waiting_approval';

export type DurableRunKillRestartCoreId =
  | 'before-model-dispatch'
  | 'after-model-response'
  | 'between-tool-begin-end'
  | 'approval-waiting'
  | 'child-agent-running'
  | 'dynamic-workflow'
  | 'agent-team-auto-agent'
  | 'external-engine'
  | 'mcp-durable-task'
  | 'adr075-model-streaming'
  | 'adr075-bash-executing'
  | 'adr075-readonly-tool'
  | 'adr075-parallel-readonly';

export interface DurableRunKillRestartScenario {
  id: string;
  coreId: DurableRunKillRestartCoreId;
  killPoint: string;
  engine: RunEngineRef;
  operationKind: PendingOperationKind;
  operationStatus: 'prepared' | 'dispatched' | 'waiting';
  sideEffect: boolean;
  providerOperationId?: string;
  expectedOutcome: DurableRunExpectedOutcome;
  expectedRecoveryAction: string;
  requiresReviewReason?: string;
  /** ADR-075 ④ live-loop E2E: recovery must attach the same runId and finish. */
  liveLoop?: boolean;
}

export const ADR075_S9_CORE_IDS = [
  'before-model-dispatch',
  'after-model-response',
  'between-tool-begin-end',
  'approval-waiting',
  'child-agent-running',
  'dynamic-workflow',
  'agent-team-auto-agent',
  'external-engine',
  'mcp-durable-task',
] as const;

export const ADR075_LIVE_LOOP_CORE_IDS = [
  'adr075-model-streaming',
  'adr075-bash-executing',
  'adr075-readonly-tool',
  'adr075-parallel-readonly',
] as const;

/** Real child-process acceptance matrix. Variants cover both safe and uncertain recovery branches. */
export const DURABLE_RUN_KILL_RESTART_SCENARIOS: readonly DurableRunKillRestartScenario[] = [
  {
    id: 'before-model-dispatch', coreId: 'before-model-dispatch',
    killPoint: 'prepared checkpoint committed before provider dispatch', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'prepared', sideEffect: false,
    // ADR-075 ④: safe recovery stays `running` with the live loop attached (same runId).
    // Pre-ADR S9 expected one-step `completed`; regenerate via startTask must still fail.
    expectedOutcome: 'running', expectedRecoveryAction: 'execute_prepared_model_once',
  },
  {
    id: 'after-model-response-queryable', coreId: 'after-model-response',
    killPoint: 'provider response returned before result checkpoint', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'dispatched', sideEffect: false,
    providerOperationId: 'model-response:queryable', expectedOutcome: 'running',
    expectedRecoveryAction: 'query_original_model_result',
  },
  {
    id: 'after-model-response-safe-retry', coreId: 'after-model-response',
    killPoint: 'unqueryable safe compute response before result checkpoint', engine: { kind: 'native' },
    operationKind: 'model_call', operationStatus: 'dispatched', sideEffect: false,
    expectedOutcome: 'running', expectedRecoveryAction: 'retry_safe_model_compute_once',
  },
  {
    id: 'between-tool-begin-end-deduplicated', coreId: 'between-tool-begin-end',
    killPoint: 'tool begin/end with provider dedupe evidence', engine: { kind: 'native' },
    operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'tool-op:confirmed', expectedOutcome: 'running',
    expectedRecoveryAction: 'query_confirmed_tool_result',
  },
  {
    id: 'between-tool-begin-end-unknown-write', coreId: 'between-tool-begin-end',
    killPoint: 'tool begin/end with unknown write side effect', engine: { kind: 'native' },
    operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    // ADR-075 ④: local unknown write → interrupt into history + loop continues.
    // Replay (dispatchPrepared) and the old waiting_review dead-end must still fail.
    expectedOutcome: 'running', expectedRecoveryAction: 'interrupt_unproven_tool_replay',
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
    engine: { kind: 'dynamic_workflow', workflowId: 'graph-dynamic-workflow' }, operationKind: 'child_run',
    operationStatus: 'prepared', sideEffect: false, expectedOutcome: 'completed',
    expectedRecoveryAction: 'resume_incomplete_nested_node',
  },
  {
    id: 'dynamic-workflow-drift', coreId: 'dynamic-workflow', killPoint: 'nested checkpoint with workspace drift',
    engine: { kind: 'dynamic_workflow', workflowId: 'graph-dynamic-workflow' }, operationKind: 'child_run',
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
    // ADR-075 ④ / Q2: external irreversible MCP write parks with guard_halt.
    // Native recovery owns this boundary; the MCP handler must not replay it.
    expectedOutcome: 'waiting_review', expectedRecoveryAction: 'unknown_write_side_effect',
    requiresReviewReason: 'unknown_write_side_effect',
  },
  {
    id: 'adr075-model-streaming', coreId: 'adr075-model-streaming', liveLoop: true,
    killPoint: 'model_call dispatched with a persisted visible delta before provider finish',
    engine: { kind: 'native' }, operationKind: 'model_call', operationStatus: 'dispatched', sideEffect: false,
    expectedOutcome: 'completed', expectedRecoveryAction: 'replay_interrupted_model_once',
  },
  {
    id: 'adr075-bash-executing', coreId: 'adr075-bash-executing', liveLoop: true,
    killPoint: 'Bash tool begin committed, complete not recorded',
    engine: { kind: 'native' }, operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: true,
    providerOperationId: 'exec-bash',
    expectedOutcome: 'completed', expectedRecoveryAction: 'interrupt_unproven_tool_replay',
  },
  {
    id: 'adr075-readonly-tool', coreId: 'adr075-readonly-tool', liveLoop: true,
    killPoint: 'Read tool begin committed',
    engine: { kind: 'native' }, operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: false,
    providerOperationId: 'exec-read',
    expectedOutcome: 'completed', expectedRecoveryAction: 'replay_safe_tool_once',
  },
  {
    id: 'adr075-parallel-readonly', coreId: 'adr075-parallel-readonly', liveLoop: true,
    killPoint: 'two parallel Read tools dispatched, descriptor pointing at the second',
    engine: { kind: 'native' }, operationKind: 'tool_call', operationStatus: 'dispatched', sideEffect: false,
    providerOperationId: 'exec-read-b',
    expectedOutcome: 'completed', expectedRecoveryAction: 'resume_live_loop',
  },
] as const;
