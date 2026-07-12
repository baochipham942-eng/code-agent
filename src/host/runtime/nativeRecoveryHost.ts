import type { PendingOperation } from '../../shared/contract/durableRun';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunRegistry } from './runRegistry';
import type { DurableEngineRecoveryHandler } from './durableRecoveryDispatcher';

export const NATIVE_RECOVERY_SCHEMA_VERSION = 1 as const;

export interface NativeRecoveryDescriptor {
  schemaVersion: typeof NATIVE_RECOVERY_SCHEMA_VERSION;
  kind: 'native';
  sourceMessageId: string;
  provider: string;
  model: string;
  workspace: { root: string; cwd: string; fingerprint: string };
  logicalOperationId: string;
  operationId: string;
  phase: 'before_model_dispatch' | 'after_model_dispatch' | 'tool_dispatched' | 'approval_waiting';
  trace?: { traceId?: string; spanId?: string };
  checkpointSequence: number;
  approvalId?: string;
}

export interface NativeRecoveryResultEvidence {
  resultRef: string;
}

export interface NativeRecoveryHostPorts {
  resolveWorkspace(descriptor: NativeRecoveryDescriptor): Promise<
    | { ok: true; root: string; cwd: string; fingerprint: string }
    | { ok: false; reason: string }
  >;
  model: {
    dispatchPrepared(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
    queryResult(input: NativeRecoveryOperationInput & { providerOperationId: string }): Promise<NativeRecoveryResultEvidence | null>;
    canRetrySafely(input: NativeRecoveryOperationInput): Promise<boolean>;
    retrySafe(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
  };
  tool: {
    queryResult(input: NativeRecoveryOperationInput & { providerOperationId: string }): Promise<NativeRecoveryResultEvidence | null>;
  };
  approval: {
    read(approvalId: string): Promise<'pending' | 'approved' | 'rejected' | 'missing' | 'conflict'>;
  };
  compatibilitySink?: {
    commitResult(input: {
      runId: string;
      sessionId: string;
      operationId: string;
      resultRef: string;
    }): Promise<void>;
  };
}

export interface NativeRecoveryOperationInput {
  plan: RunRehydrationPlan;
  descriptor: NativeRecoveryDescriptor;
  operation: PendingOperation;
}

export function isNativeRecoveryDescriptor(value: unknown): value is NativeRecoveryDescriptor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NativeRecoveryDescriptor>;
  return candidate.schemaVersion === NATIVE_RECOVERY_SCHEMA_VERSION
    && candidate.kind === 'native'
    && typeof candidate.sourceMessageId === 'string'
    && typeof candidate.provider === 'string'
    && typeof candidate.model === 'string'
    && typeof candidate.logicalOperationId === 'string'
    && typeof candidate.operationId === 'string'
    && typeof candidate.checkpointSequence === 'number'
    && Boolean(candidate.workspace)
    && typeof candidate.workspace?.root === 'string'
    && typeof candidate.workspace?.cwd === 'string'
    && typeof candidate.workspace?.fingerprint === 'string';
}

export class NativeRecoveryHost {
  constructor(
    private readonly registry: RunRegistry,
    private readonly ports: NativeRecoveryHostPorts,
  ) {}

  createHandler(): DurableEngineRecoveryHandler {
    return {
      name: 'native_production',
      engineKind: 'native',
      recover: (plan, now) => this.recover(plan, now),
    };
  }

  private async recover(plan: RunRehydrationPlan, now: number) {
    const descriptor = plan.checkpoint?.state;
    if (!isNativeRecoveryDescriptor(descriptor)) {
      return this.review(plan, now, 'native_recovery_descriptor_missing');
    }
    if (descriptor.operationId !== descriptor.logicalOperationId
      && !plan.pendingOperations.some((operation) => operation.operationId === descriptor.operationId)) {
      return this.review(plan, now, 'native_operation_identity_conflict');
    }
    const resolvedWorkspace = await this.ports.resolveWorkspace(descriptor);
    if (!resolvedWorkspace.ok
      || resolvedWorkspace.root !== descriptor.workspace.root
      || resolvedWorkspace.cwd !== descriptor.workspace.cwd
      || resolvedWorkspace.fingerprint !== descriptor.workspace.fingerprint) {
      return this.review(plan, now, resolvedWorkspace.ok ? 'native_workspace_drift' : resolvedWorkspace.reason);
    }
    const operation = plan.pendingOperations.find((candidate) => candidate.operationId === descriptor.operationId);
    if (!operation) return this.review(plan, now, 'native_operation_missing');

    if (operation.kind === 'approval') return this.recoverApproval(plan, descriptor, operation, now);
    if (operation.kind === 'tool_call' && operation.providerOperationId?.startsWith('mcp-task:v1:')) {
      return { status: 'observing' as const, reason: 'native_waits_for_mcp_operation_handler' };
    }

    const input = { plan, descriptor, operation };
    let evidence: NativeRecoveryResultEvidence | null = null;
    let action = '';
    if (operation.kind === 'model_call' && operation.status === 'prepared') {
      evidence = await this.ports.model.dispatchPrepared(input);
      action = 'execute_prepared_model_once';
    } else if (operation.kind === 'model_call' && operation.status === 'dispatched' && operation.providerOperationId) {
      evidence = await this.ports.model.queryResult({ ...input, providerOperationId: operation.providerOperationId });
      action = 'query_original_model_result';
      if (!evidence) return this.review(plan, now, 'model_result_handle_not_queryable');
    } else if (operation.kind === 'model_call' && operation.status === 'dispatched') {
      if (!await this.ports.model.canRetrySafely(input)) {
        return this.review(plan, now, 'model_safe_retry_unproven');
      }
      evidence = await this.ports.model.retrySafe(input);
      action = 'retry_safe_model_compute_once';
    } else if (operation.kind === 'tool_call'
      && operation.providerOperationId
      && operation.requiresHumanConfirmation !== true) {
      evidence = await this.ports.tool.queryResult({ ...input, providerOperationId: operation.providerOperationId });
      action = 'query_confirmed_tool_result';
      if (!evidence) return this.review(plan, now, 'tool_result_evidence_missing');
    } else if (operation.kind === 'tool_call' && operation.sideEffect) {
      return this.review(plan, now, 'unknown_write_side_effect');
    } else {
      return this.review(plan, now, 'native_operation_not_safely_recoverable');
    }

    await this.ports.compatibilitySink?.commitResult({
      runId: plan.envelope.runId,
      sessionId: plan.envelope.sessionId,
      operationId: operation.operationId,
      resultRef: evidence.resultRef,
    });
    const pendingOperations = plan.pendingOperations.map((candidate) => candidate.operationId === operation.operationId
      ? { ...candidate, status: 'succeeded' as const, resultRef: evidence.resultRef, updatedAt: now }
      : candidate);
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'running',
      state: descriptor,
      engineCursor: plan.checkpoint?.cursor.engineCursor,
      pendingOperations,
      childRuns: plan.childRuns,
      events: [{ type: 'native_recovery_result_committed', payload: { operationId: operation.operationId }, recordedAt: now }],
    });
    await this.registry.terminalDurable(plan.envelope.runId, {
      now: now + 1,
      status: 'completed',
      reason: action,
      event: { type: 'run_completed', payload: { recoveryAction: action }, recordedAt: now + 1 },
    });
    return { status: 'recovered' as const, reason: action, detail: { resultRef: evidence.resultRef } };
  }

  private async recoverApproval(
    plan: RunRehydrationPlan,
    descriptor: NativeRecoveryDescriptor,
    operation: PendingOperation,
    now: number,
  ) {
    const approvalId = descriptor.approvalId ?? operation.providerOperationId?.replace(/^approval:/, '');
    if (!approvalId) return this.review(plan, now, 'approval_identity_missing');
    const status = await this.ports.approval.read(approvalId);
    if (status === 'missing' || status === 'conflict') return this.review(plan, now, `approval_identity_${status}`);
    if (status === 'pending') {
      await this.registry.checkpointDurable(plan.envelope.runId, {
        now,
        status: 'waiting',
        state: descriptor,
        engineCursor: plan.checkpoint?.cursor.engineCursor,
        pendingOperations: plan.pendingOperations,
        childRuns: plan.childRuns,
        events: [{ type: 'approval_recovered', payload: { approvalId }, recordedAt: now }],
      });
      return { status: 'observing' as const, reason: 'restore_same_approval' };
    }
    return this.review(plan, now, `approval_${status}_continuation_requires_application_resume`);
  }

  private async review(plan: RunRehydrationPlan, now: number, reason: string) {
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'waiting',
      state: plan.checkpoint?.state,
      engineCursor: plan.checkpoint?.cursor.engineCursor,
      pendingOperations: plan.pendingOperations.map((operation) => operation.sideEffect && operation.status === 'dispatched'
        ? { ...operation, status: 'unknown' as const, requiresHumanConfirmation: true, updatedAt: now }
        : operation),
      childRuns: plan.childRuns,
      events: [{ type: 'native_recovery_requires_review', payload: { reason }, recordedAt: now }],
    });
    return { status: 'requires_review' as const, reason };
  }
}

export function createUnavailableNativeRecoveryPorts(): NativeRecoveryHostPorts {
  const unavailable = async (): Promise<never> => { throw new Error('native recovery application dependency unavailable'); };
  return {
    resolveWorkspace: async () => ({ ok: false, reason: 'native_workspace_resolver_unavailable' }),
    model: {
      dispatchPrepared: unavailable,
      queryResult: unavailable,
      canRetrySafely: async () => false,
      retrySafe: unavailable,
    },
    tool: { queryResult: unavailable },
    approval: { read: async () => 'missing' },
  };
}
