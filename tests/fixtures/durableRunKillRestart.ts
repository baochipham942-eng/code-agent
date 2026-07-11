export interface DurableRunKillRestartScenario {
  id: string;
  killPoint: string;
  legacyTable: 'session_events' | 'tool_execution_events' | 'pending_approvals' | 'swarm_run_ledger';
  missingEvidence: readonly string[];
  expectedRecovery: string;
}

/**
 * S0 failure skeleton. S9 should turn each row into a real child-process kill/restart test
 * and remove the corresponding legacy-schema assertion only after recovery passes.
 */
export const DURABLE_RUN_KILL_RESTART_SCENARIOS: readonly DurableRunKillRestartScenario[] = [
  {
    id: 'before-model-dispatch',
    killPoint: 'model call 前（prepared checkpoint 后、provider dispatch 前）',
    legacyTable: 'session_events',
    missingEvidence: ['run_id', 'attempt', 'seq', 'idempotency_key'],
    expectedRecovery: 'reuse the logical operation key and execute the model node on the next attempt',
  },
  {
    id: 'after-model-response',
    killPoint: 'model call 后（provider response 后、result checkpoint 前）',
    legacyTable: 'session_events',
    missingEvidence: ['run_id', 'attempt', 'seq', 'idempotency_key'],
    expectedRecovery: 'retry if provider result cannot be queried, then commit output once under the fenced event seq',
  },
  {
    id: 'between-tool-begin-end',
    killPoint: 'tool begin/end 之间',
    legacyTable: 'tool_execution_events',
    missingEvidence: ['run_id', 'attempt', 'idempotency_key', 'owner_epoch'],
    expectedRecovery: 'deduplicate or query the result; require human confirmation for an uncertain side effect',
  },
  {
    id: 'approval-waiting',
    killPoint: 'approval waiting',
    legacyTable: 'pending_approvals',
    missingEvidence: ['run_id', 'attempt', 'checkpoint_seq', 'idempotency_key'],
    expectedRecovery: 'restore the same unanswered approval and remain waiting',
  },
  {
    id: 'child-agent-running',
    killPoint: 'child agent running',
    legacyTable: 'swarm_run_ledger',
    missingEvidence: ['parent_run_id', 'attempt', 'checkpoint_seq', 'owner_epoch'],
    expectedRecovery: 'reconcile the existing child reference before scheduling any child node again',
  },
] as const;
