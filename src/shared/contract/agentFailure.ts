// ============================================================================
// Agent Failure Contract
// ============================================================================

export enum AgentFailureCode {
  BlockedByParentRole = 'blocked-by-parent-role',
  PermissionDenied = 'permission-denied',
  ToolUnavailable = 'tool-unavailable',
  BudgetExhausted = 'budget-exhausted',
  Timeout = 'timeout',
  ParentGone = 'parent-gone',
  CancelledByUser = 'cancelled-by-user',
  CancelledByParent = 'cancelled-by-parent',
  DependencyFailed = 'dependency-failed',
  DependencyMissing = 'dependency-missing',
  WorkflowStageFailed = 'workflow-stage-failed',
  WorktreeCreateFailed = 'worktree-create-failed',
  ModelError = 'model-error',
  Unknown = 'unknown',
}

export const AGENT_FAILURE_CODE_VALUES = Object.values(AgentFailureCode);

export function isAgentFailureCode(value: unknown): value is AgentFailureCode {
  return typeof value === 'string'
    && (AGENT_FAILURE_CODE_VALUES as readonly string[]).includes(value);
}

export function agentFailureCodeFromCancellationReason(reason: unknown): AgentFailureCode | undefined {
  if (isAgentFailureCode(reason)) return reason;
  if (typeof reason !== 'string') return undefined;

  switch (reason) {
    case 'user-cancel':
    case 'session-switch':
    case 'user_cancelled':
    case 'run_cancelled':
    case 'cancelled':
      return AgentFailureCode.CancelledByUser;
    case 'parent-cancel':
    case 'parent_cancel':
    case 'coordinator_shutdown':
    case 'reset':
      return AgentFailureCode.CancelledByParent;
    case 'timeout':
    case 'idle-timeout':
      return AgentFailureCode.Timeout;
    case 'parent-gone':
      return AgentFailureCode.ParentGone;
    case 'budget-exceeded':
    case 'child-max-tokens':
      return AgentFailureCode.BudgetExhausted;
    case 'child-refusal':
      return AgentFailureCode.BlockedByParentRole;
    case 'child-error':
      return AgentFailureCode.ModelError;
    default:
      return undefined;
  }
}

export function agentFailureCodeFromToolResultCode(code: unknown): AgentFailureCode | undefined {
  if (isAgentFailureCode(code)) return code;
  if (typeof code !== 'string') return undefined;

  switch (code) {
    case 'PERMISSION_DENIED':
      return AgentFailureCode.PermissionDenied;
    case 'ABORTED':
      return AgentFailureCode.CancelledByUser;
    case 'NOT_INITIALIZED':
      return AgentFailureCode.ModelError;
    case 'INVALID_ARGS':
      return AgentFailureCode.ToolUnavailable;
    default:
      return undefined;
  }
}

export function inferAgentFailureCode(input: {
  failureCode?: unknown;
  cancellationReason?: unknown;
  toolResultCode?: unknown;
  error?: unknown;
  defaultCode?: AgentFailureCode;
} = {}): AgentFailureCode {
  if (isAgentFailureCode(input.failureCode)) return input.failureCode;

  const fromCancellation = agentFailureCodeFromCancellationReason(input.cancellationReason);
  if (fromCancellation) return fromCancellation;

  const fromToolCode = agentFailureCodeFromToolResultCode(input.toolResultCode);
  if (fromToolCode) return fromToolCode;

  const message = typeof input.error === 'string'
    ? input.error
    : input.error instanceof Error
      ? input.error.message
      : '';
  const normalized = message.toLowerCase();

  if (normalized.includes('permission denied') || normalized.includes('blocked by plan approval')) {
    return AgentFailureCode.PermissionDenied;
  }
  if (normalized.includes('worktree') && (normalized.includes('create') || normalized.includes('add'))) {
    return AgentFailureCode.WorktreeCreateFailed;
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return AgentFailureCode.Timeout;
  }
  if (normalized.includes('parent-gone') || normalized.includes('parent run gone')) {
    return AgentFailureCode.ParentGone;
  }
  if (normalized.includes('cancel') || normalized.includes('abort') || message.includes('取消')) {
    return AgentFailureCode.CancelledByUser;
  }
  if (normalized.includes('budget') || normalized.includes('max token')) {
    return AgentFailureCode.BudgetExhausted;
  }
  if (normalized.includes('missing dependencies') || normalized.includes('missing dependency')) {
    return AgentFailureCode.DependencyMissing;
  }
  if (normalized.includes('failed dependencies') || normalized.includes('dependency failed')) {
    return AgentFailureCode.DependencyFailed;
  }
  if (normalized.includes('unknown agent') || normalized.includes('unknown role') || normalized.includes('unknown workflow')) {
    return AgentFailureCode.ToolUnavailable;
  }
  if (normalized.includes('workflow') || normalized.includes('stage')) {
    return AgentFailureCode.WorkflowStageFailed;
  }
  if (normalized.includes('model') || normalized.includes('inference') || normalized.includes('provider')) {
    return AgentFailureCode.ModelError;
  }

  return input.defaultCode ?? AgentFailureCode.Unknown;
}
