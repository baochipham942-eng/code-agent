import { describe, expect, it } from 'vitest';
import {
  AgentFailureCode,
  AGENT_FAILURE_CODE_VALUES,
  agentFailureCodeFromCancellationReason,
  agentFailureCodeFromToolResultCode,
  inferAgentFailureCode,
  isAgentFailureCode,
} from '../../../../src/shared/contract/agentFailure';

describe('AgentFailureCode contract', () => {
  it('contains the P0 tool-platform failure code set', () => {
    expect(AGENT_FAILURE_CODE_VALUES).toEqual([
      'blocked-by-parent-role',
      'permission-denied',
      'tool-unavailable',
      'budget-exhausted',
      'timeout',
      'parent-gone',
      'cancelled-by-user',
      'cancelled-by-parent',
      'dependency-failed',
      'dependency-missing',
      'workflow-stage-failed',
      'worktree-create-failed',
      'model-error',
      'unknown',
    ]);
  });

  it('maps existing cancellation reasons into the unified agent code set', () => {
    expect(agentFailureCodeFromCancellationReason('child-refusal')).toBe(AgentFailureCode.BlockedByParentRole);
    expect(agentFailureCodeFromCancellationReason('child-max-tokens')).toBe(AgentFailureCode.BudgetExhausted);
    expect(agentFailureCodeFromCancellationReason('timeout')).toBe(AgentFailureCode.Timeout);
    expect(agentFailureCodeFromCancellationReason('parent-gone')).toBe(AgentFailureCode.ParentGone);
    expect(agentFailureCodeFromCancellationReason('parent-cancel')).toBe(AgentFailureCode.CancelledByParent);
    expect(agentFailureCodeFromCancellationReason('user-cancel')).toBe(AgentFailureCode.CancelledByUser);
  });

  it('maps native tool result codes without leaking protocol-specific strings', () => {
    expect(agentFailureCodeFromToolResultCode('PERMISSION_DENIED')).toBe(AgentFailureCode.PermissionDenied);
    expect(agentFailureCodeFromToolResultCode('ABORTED')).toBe(AgentFailureCode.CancelledByUser);
    expect(agentFailureCodeFromToolResultCode('NOT_INITIALIZED')).toBe(AgentFailureCode.ModelError);
    expect(agentFailureCodeFromToolResultCode('INVALID_ARGS')).toBe(AgentFailureCode.ToolUnavailable);
  });

  it('infers stable codes from error text only as a fallback', () => {
    expect(inferAgentFailureCode({ error: 'Failed to create worktree for agent' })).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(inferAgentFailureCode({ error: 'Blocked by missing dependencies: a' })).toBe(AgentFailureCode.DependencyMissing);
    expect(inferAgentFailureCode({ error: 'Blocked by failed dependencies: a' })).toBe(AgentFailureCode.DependencyFailed);
    expect(inferAgentFailureCode({ error: 'Unknown workflow: qa' })).toBe(AgentFailureCode.ToolUnavailable);
    expect(inferAgentFailureCode({ error: 'provider inference failed' })).toBe(AgentFailureCode.ModelError);
  });

  it('guards persisted strings before consumers treat them as known codes', () => {
    expect(isAgentFailureCode('timeout')).toBe(true);
    expect(isAgentFailureCode('depth-limit')).toBe(false);
  });
});
