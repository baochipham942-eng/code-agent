import type { PendingOperation } from '../../shared/contract/durableRun';
import type { ToolReplaySafety } from '../../shared/contract';
import type { WorkspaceScope } from '../../shared/contract/project';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunRegistry } from './runRegistry';
import type { DurableEngineRecoveryHandler } from './durableRecoveryDispatcher';
import { canAutomaticallyReplayTool } from '../tools/toolReplaySafety';

export const NATIVE_RECOVERY_SCHEMA_VERSION = 1 as const;

export interface NativeRecoveryDescriptor {
  schemaVersion: typeof NATIVE_RECOVERY_SCHEMA_VERSION;
  kind: 'native';
  sourceMessageId: string;
  provider: string;
  model: string;
  workspace: { root: string; cwd: string; fingerprint: string; scope?: WorkspaceScope };
  logicalOperationId: string;
  operationId: string;
  phase: 'before_model_dispatch' | 'after_model_dispatch' | 'tool_dispatched' | 'approval_waiting';
  trace?: { traceId?: string; spanId?: string };
  checkpointSequence: number;
  approvalId?: string;
  /**
   * Set when the run is a /goal autonomous loop. Recovery must never auto-`completed`
   * a goal run — its verify/review gates only run inside the live loop. Absent on
   * pre-goal-marking checkpoints (undefined = not a goal run, back-compatible).
   */
  isGoalRun?: boolean;
}

export interface NativeRecoveryResultEvidence {
  resultRef: string;
  /** The application port already re-entered the live loop while settling this operation. */
  loopResumed?: boolean;
}

type NativeRecoveryApprovalStatus = 'pending' | 'approved' | 'rejected' | 'missing' | 'conflict';

interface NativeRecoveryApprovalResolution {
  status: NativeRecoveryApprovalStatus;
  feedback?: string | null;
}

export interface NativeRecoveryHostPorts {
  /** Missing means the caller supplied a real recovery executor; production fallbacks must opt out explicitly. */
  continuationExecutor?: 'available' | 'unavailable';
  resolveWorkspace(descriptor: NativeRecoveryDescriptor): Promise<
    | { ok: true; root: string; cwd: string; fingerprint: string }
    | { ok: false; reason: string }
  >;
  /**
   * Resolve the current version of the checkpointed scope so recovery cannot silently
   * regain or retain stale permissions. Receives the whole scope: synthetic scopes
   * (e.g. legacy-background-authority) are recomputed from their roots, real Project
   * scopes are re-derived from the Project library.
   */
  resolveWorkspaceScopeVersion?(scope: WorkspaceScope): Promise<string | null>;
  model: {
    dispatchPrepared(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
    queryResult(input: NativeRecoveryOperationInput & { providerOperationId: string }): Promise<NativeRecoveryResultEvidence | null>;
    canRetrySafely(input: NativeRecoveryOperationInput): Promise<boolean>;
    retrySafe(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
  };
  tool: {
    queryResult(input: NativeRecoveryOperationInput & { providerOperationId: string }): Promise<NativeRecoveryResultEvidence | null>;
    classifyReplaySafety(input: NativeRecoveryOperationInput): Promise<{
      stored: ToolReplaySafety | null;
      current: ToolReplaySafety;
    }>;
    dispatchPrepared(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
    interrupt(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
  };
  /** Re-enter the live loop after recovery has materialized every pending operation. */
  continueLoop?(input: NativeRecoveryOperationInput): Promise<void>;
  approval: {
    read(approvalId: string): Promise<NativeRecoveryApprovalResolution | NativeRecoveryApprovalStatus>;
    /** Return a result already materialized before a recovery crash; never execute here. */
    queryResult?(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence | null>;
    /** Execute an approved operation exactly once, after the recovery fence is durable. */
    dispatchPrepared?(input: NativeRecoveryOperationInput): Promise<NativeRecoveryResultEvidence>;
    /** Materialize a denial for the model so the existing run can continue its loop. */
    reject?(input: NativeRecoveryOperationInput, feedback?: string | null): Promise<NativeRecoveryResultEvidence>;
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
    if (descriptor.isGoalRun) {
      return this.reviewInterruptedGoal(plan, now);
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
    if (descriptor.workspace.scope) {
      const currentScopeVersion = await this.ports.resolveWorkspaceScopeVersion?.(
        descriptor.workspace.scope,
      );
      if (!currentScopeVersion || currentScopeVersion !== descriptor.workspace.scope.version) {
        return this.review(plan, now, 'native_workspace_scope_drift');
      }
    }
    const descriptorOperation = plan.pendingOperations.find((candidate) => candidate.operationId === descriptor.operationId);
    if (!descriptorOperation) return this.review(plan, now, 'native_operation_missing');

    // The checkpoint descriptor points at the last operation only. Recover every
    // non-terminal sibling first, then let the descriptor operation be the final
    // operation to enter the live loop. This prevents a parallel tool call from
    // reaching the provider with a missing sibling tool_result.
    const pendingOperations = [...plan.pendingOperations];
    const recoverable = pendingOperations
      .filter((operation) => !isTerminalOperation(operation))
      .sort((left, right) => Number(left.operationId === descriptor.operationId) - Number(right.operationId === descriptor.operationId));
    let guardHalt = false;
    let waitingForApproval = false;
    let loopResumed = false;
    let recoveredToolResult = false;
    let recoveredApprovalResult = false;
    let lastAction = 'settle_native_operations';
    let lastResultRef: string | undefined;

    for (const operation of recoverable) {
      if (waitingForApproval || guardHalt) continue;
      const operationDescriptor = descriptorForOperation(descriptor, operation);
      const operationPlan = operation.operationId === descriptor.operationId && operation.kind === 'model_call'
        ? {
            ...plan,
            envelope: { ...plan.envelope, pendingOperations },
            pendingOperations: [...pendingOperations],
          }
        : plan;
      const input = { plan: operationPlan, descriptor: operationDescriptor, operation };
      if (operation.kind === 'approval') {
        const approvalId = operationDescriptor.approvalId ?? operation.providerOperationId?.replace(/^approval:/, '');
        if (!approvalId) {
          return this.ports.continuationExecutor === 'unavailable'
            ? this.failUnrecoverable(plan, now, 'approval_identity_missing')
            : this.review(plan, now, 'approval_identity_missing');
        }
        const approvalResolution = normalizeApprovalResolution(await this.ports.approval.read(approvalId));
        const approvalStatus = approvalResolution.status;
        if (approvalStatus === 'missing' || approvalStatus === 'conflict') {
          return this.ports.continuationExecutor === 'unavailable'
            ? this.failUnrecoverable(plan, now, 'approval_identity_missing')
            : this.review(plan, now, `approval_identity_${approvalStatus}`);
        }
        if (approvalStatus === 'pending') {
          if (this.ports.continuationExecutor === 'unavailable') {
            return this.failUnrecoverable(plan, now, 'approval_pending_no_recovery_resolution_path');
          }
          waitingForApproval = true;
          continue;
        }
        if (approvalStatus === 'approved') {
          if (operation.status !== 'waiting') {
            const existing = await this.ports.approval.queryResult?.(input);
            if (!existing) return this.review(plan, now, 'approval_dispatch_outcome_unknown');
            await this.ports.compatibilitySink?.commitResult({
              runId: plan.envelope.runId,
              sessionId: plan.envelope.sessionId,
              operationId: operation.operationId,
              resultRef: existing.resultRef,
            });
            replacePendingOperation(pendingOperations, operation, {
              status: 'succeeded',
              resultRef: existing.resultRef,
              updatedAt: now,
            });
            recoveredApprovalResult = true;
            loopResumed ||= existing.loopResumed === true;
            lastAction = 'recover_approved_operation_result';
            lastResultRef = existing.resultRef;
            continue;
          }
          if (!this.ports.approval.dispatchPrepared) {
            return this.ports.continuationExecutor === 'unavailable'
              ? this.failUnrecoverable(plan, now, 'approval_approved_continuation_requires_application_resume')
              : this.review(plan, now, 'approval_approved_continuation_requires_application_resume');
          }
          const fencedOperations = pendingOperations.map((candidate) => (
            candidate.operationId === operation.operationId
              ? { ...candidate, status: 'unknown' as const, requiresHumanConfirmation: true, updatedAt: now }
              : candidate
          ));
          await this.registry.checkpointDurable(plan.envelope.runId, {
            now,
            status: 'running',
            state: operationDescriptor,
            engineCursor: plan.checkpoint?.cursor.engineCursor,
            pendingOperations: fencedOperations,
            childRuns: plan.childRuns,
            events: [{
              type: 'native_approval_recovery_dispatch_fenced',
              payload: { operationId: operation.operationId, approvalId },
              recordedAt: now,
            }],
          });
          const settled = await this.ports.approval.dispatchPrepared({
            ...input,
            plan: {
              ...plan,
              envelope: { ...plan.envelope, pendingOperations: fencedOperations },
              pendingOperations: fencedOperations,
            },
          });
          await this.ports.compatibilitySink?.commitResult({
            runId: plan.envelope.runId,
            sessionId: plan.envelope.sessionId,
            operationId: operation.operationId,
            resultRef: settled.resultRef,
          });
          replacePendingOperation(pendingOperations, operation, {
            status: 'succeeded',
            resultRef: settled.resultRef,
            updatedAt: now,
          });
          recoveredApprovalResult = true;
          loopResumed ||= settled.loopResumed === true;
          lastAction = 'execute_approved_operation_once';
          lastResultRef = settled.resultRef;
          continue;
        }
        if (approvalStatus === 'rejected') {
          if (!this.ports.approval.reject) {
            return this.ports.continuationExecutor === 'unavailable'
              ? this.failUnrecoverable(plan, now, 'approval_rejection_feedback_unavailable')
              : this.review(plan, now, 'approval_rejection_feedback_unavailable');
          }
          const settled = await this.ports.approval.reject(input, approvalResolution.feedback);
          await this.ports.compatibilitySink?.commitResult({
            runId: plan.envelope.runId,
            sessionId: plan.envelope.sessionId,
            operationId: operation.operationId,
            resultRef: settled.resultRef,
          });
          replacePendingOperation(pendingOperations, operation, {
            status: 'failed',
            resultRef: settled.resultRef,
            updatedAt: now,
          });
          recoveredApprovalResult = true;
          loopResumed ||= settled.loopResumed === true;
          lastAction = 'feed_approval_rejection_to_model';
          lastResultRef = settled.resultRef;
          continue;
        }
        return this.ports.continuationExecutor === 'unavailable'
          ? this.failUnrecoverable(plan, now, `approval_${approvalStatus}_continuation_requires_application_resume`)
          : this.review(plan, now, `approval_${approvalStatus}_continuation_requires_application_resume`);
      }
      if (operation.kind === 'tool_call' && operation.providerOperationId?.startsWith('mcp-task:v1:')) {
        // Read-only MCP tasks remain owned by the explicit MCP handler. External
        // writes continue through recoverOperation so an already recorded success
        // can be materialized, while an unknown outcome parks with guard_halt.
        if (!operation.sideEffect) {
          const siblingsChanged = pendingOperations.some((candidate, index) => (
            candidate.status !== plan.pendingOperations[index]?.status
              || candidate.resultRef !== plan.pendingOperations[index]?.resultRef
          ));
          if (siblingsChanged) {
            await this.registry.checkpointDurable(plan.envelope.runId, {
              now,
              status: 'running',
              state: descriptor,
              engineCursor: plan.checkpoint?.cursor.engineCursor,
              pendingOperations,
              childRuns: plan.childRuns,
              events: [{ type: 'native_recovery_siblings_settled', payload: { operationId: operation.operationId }, recordedAt: now }],
            });
          }
          return { status: 'observing' as const, reason: 'native_waits_for_mcp_operation_handler' };
        }
      }

      // A prepared model recovery can enter the live loop inside dispatchPrepared.
      // Persist settled siblings before that call so a natural loop finalization
      // never observes an unresolved parallel operation.
      if (operation.operationId === descriptor.operationId
        && operation.kind === 'model_call'
        && pendingOperations.some((candidate, index) => candidate.status !== plan.pendingOperations[index]?.status)) {
        await this.registry.checkpointDurable(plan.envelope.runId, {
          now,
          status: 'running',
          state: descriptor,
          engineCursor: plan.checkpoint?.cursor.engineCursor,
          pendingOperations,
          childRuns: plan.childRuns,
          events: [{ type: 'native_recovery_siblings_settled', payload: { operationId: operation.operationId }, recordedAt: now }],
        });
      }
      const settled = await this.recoverOperation(input);
      if (settled.reviewReason) {
        if (settled.guardHalt) {
          guardHalt = true;
          replacePendingOperation(pendingOperations, operation, {
            status: 'unknown',
            requiresHumanConfirmation: true,
            updatedAt: now,
          });
          continue;
        }
        return this.review(plan, now, settled.reviewReason);
      }
      if (!settled.evidence) continue;
      await this.ports.compatibilitySink?.commitResult({
        runId: plan.envelope.runId,
        sessionId: plan.envelope.sessionId,
        operationId: operation.operationId,
        resultRef: settled.evidence.resultRef,
      });
      replacePendingOperation(pendingOperations, operation, {
        status: 'succeeded',
        resultRef: settled.evidence.resultRef,
        updatedAt: now,
      });
      recoveredToolResult ||= operation.kind === 'tool_call';
      loopResumed ||= settled.evidence.loopResumed === true;
      lastAction = settled.action;
      lastResultRef = settled.evidence.resultRef;
    }

    if (waitingForApproval) {
      await this.registry.checkpointDurable(plan.envelope.runId, {
        now,
        status: 'waiting',
        state: descriptor,
        engineCursor: plan.checkpoint?.cursor.engineCursor,
        pendingOperations,
        childRuns: plan.childRuns,
        events: [{ type: 'approval_recovered', payload: { runId: plan.envelope.runId }, recordedAt: now }],
      });
      return { status: 'observing' as const, reason: 'restore_same_approval' };
    }
    if (guardHalt) {
      await this.registry.checkpointDurable(plan.envelope.runId, {
        now,
        status: 'waiting',
        state: descriptor,
        engineCursor: plan.checkpoint?.cursor.engineCursor,
        pendingOperations,
        childRuns: plan.childRuns,
        interruptCause: 'guard_halt',
        events: [{ type: 'native_recovery_requires_review', payload: { reason: 'unknown_write_side_effect' }, recordedAt: now }],
      });
      return { status: 'requires_review' as const, reason: 'unknown_write_side_effect' };
    }

    if (loopResumed) {
      return {
        status: 'recovered' as const,
        reason: 'resume_live_loop',
        detail: {
          ...(lastResultRef ? { resultRef: lastResultRef } : {}),
          recoveredOperationIds: recoverable.map((operation) => operation.operationId),
        },
      };
    }
    if (!recoveredToolResult && !recoveredApprovalResult) {
      return this.review(
        plan,
        now,
        recoverable.length === 0
          ? 'native_operation_already_settled'
          : 'native_model_result_materialized_requires_review',
      );
    }
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'running',
      state: descriptor,
      engineCursor: plan.checkpoint?.cursor.engineCursor,
      pendingOperations,
      childRuns: plan.childRuns,
      events: [{
        type: 'native_recovery_operations_settled',
        payload: { operationIds: recoverable.map((operation) => operation.operationId) },
        recordedAt: now,
      }],
    });
    if (!loopResumed && this.ports.continueLoop) {
      await this.ports.continueLoop({ plan, descriptor, operation: descriptorOperation });
      loopResumed = true;
      lastAction = 'resume_live_loop';
    }
    return {
      status: 'recovered' as const,
      reason: loopResumed ? 'resume_live_loop' : lastAction,
      detail: {
        ...(lastResultRef ? { resultRef: lastResultRef } : {}),
        recoveredOperationIds: recoverable.map((operation) => operation.operationId),
      },
    };
  }

  private async recoverOperation(input: NativeRecoveryOperationInput): Promise<{
    evidence?: NativeRecoveryResultEvidence;
    action: string;
    reviewReason?: string;
    guardHalt?: boolean;
  }> {
    const { operation } = input;
    if (operation.kind === 'model_call' && operation.status === 'prepared') {
      if (this.ports.continuationExecutor === 'unavailable') return { action: 'model_unavailable', reviewReason: 'native_model_continuation_executor_unavailable' };
      return { evidence: await this.ports.model.dispatchPrepared(input), action: 'execute_prepared_model_once' };
    }
    if (operation.kind === 'model_call' && operation.status === 'dispatched' && operation.providerOperationId) {
      const evidence = await this.ports.model.queryResult({ ...input, providerOperationId: operation.providerOperationId });
      if (evidence) return { evidence, action: 'query_original_model_result' };
      if (this.ports.continuationExecutor === 'available') {
        return {
          evidence: await this.ports.model.dispatchPrepared(input),
          action: 'replay_interrupted_model_once',
        };
      }
      return { action: 'model_result_unqueryable', reviewReason: 'model_result_handle_not_queryable' };
    }
    if (operation.kind === 'model_call' && operation.status === 'dispatched') {
      if (this.ports.continuationExecutor === 'available') {
        return {
          evidence: await this.ports.model.dispatchPrepared(input),
          action: 'replay_interrupted_model_once',
        };
      }
      if (!await this.ports.model.canRetrySafely(input)) {
        return { action: 'model_retry_unproven', reviewReason: 'model_safe_retry_unproven' };
      }
      return { evidence: await this.ports.model.retrySafe(input), action: 'retry_safe_model_compute_once' };
    }
    if (operation.kind === 'tool_call') {
      let evidence: NativeRecoveryResultEvidence | null = null;
      if (operation.providerOperationId && operation.requiresHumanConfirmation !== true) {
        evidence = await this.ports.tool.queryResult({ ...input, providerOperationId: operation.providerOperationId });
      }
      if (evidence) return { evidence, action: 'query_confirmed_tool_result' };
      if (this.ports.continuationExecutor === 'unavailable') {
        return {
          action: 'tool_unavailable',
          reviewReason: operation.providerOperationId
            ? 'tool_result_evidence_missing'
            : operation.sideEffect
              ? 'unknown_write_side_effect'
              : 'tool_result_evidence_missing',
        };
      }
      const replaySafety = await this.ports.tool.classifyReplaySafety(input);
      // Unknown writes are never replayed. Local writes are materialized as an
      // interrupted result so the model can verify them; external writes park.
      if (operation.sideEffect && operation.providerOperationId?.startsWith('mcp-task:v1:')) {
        return { action: 'unknown_write_side_effect', reviewReason: 'unknown_write_side_effect', guardHalt: true };
      }
      if (operation.sideEffect) {
        return { evidence: await this.ports.tool.interrupt(input), action: 'interrupt_unproven_tool_replay' };
      }
      if (canAutomaticallyReplayTool(replaySafety.stored, replaySafety.current)) {
        return { evidence: await this.ports.tool.dispatchPrepared(input), action: 'replay_safe_tool_once' };
      }
      return { evidence: await this.ports.tool.interrupt(input), action: 'interrupt_unproven_tool_replay' };
    }
    return { action: 'native_operation_not_safely_recoverable', reviewReason: 'native_operation_not_safely_recoverable' };
  }

  private async failUnrecoverable(plan: RunRehydrationPlan, now: number, reason: string) {
    await this.registry.terminalDurable(plan.envelope.runId, {
      now,
      status: 'failed',
      reason,
      event: { type: 'run_failed', payload: { recoveryReason: reason }, recordedAt: now },
    });
    return { status: 'failed' as const, reason };
  }

  private async review(plan: RunRehydrationPlan, now: number, reason: string) {
    const canPauseForManualWorkspaceReview = reason === 'native_workspace_scope_drift';
    if (this.ports.continuationExecutor === 'unavailable' && !canPauseForManualWorkspaceReview) {
      return this.failUnrecoverable(plan, now, reason);
    }
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'waiting',
      state: plan.checkpoint?.state,
      engineCursor: plan.checkpoint?.cursor.engineCursor,
      pendingOperations: plan.pendingOperations.map((operation) => operation.sideEffect && operation.status === 'dispatched'
        ? { ...operation, status: 'unknown' as const, requiresHumanConfirmation: true, updatedAt: now }
        : operation),
      childRuns: plan.childRuns,
      ...(reason === 'unknown_write_side_effect' ? { interruptCause: 'guard_halt' as const } : {}),
      events: [{ type: 'native_recovery_requires_review', payload: { reason }, recordedAt: now }],
    });
    return { status: 'requires_review' as const, reason };
  }

  /**
   * Interrupted /goal run: never auto-`completed`. The completion decision belongs to the
   * goal loop's verify/review gates, which recovery does not re-enter — replaying one pending
   * operation and terminating `completed` would report a goal as done that never passed
   * verification (the false-completion P0). Surface the real terminal (`goal_complete` aborted /
   * interrupted) and route to review. Actually re-running the goal loop is a separate ticket.
   */
  private async reviewInterruptedGoal(plan: RunRehydrationPlan, now: number) {
    const reason = 'goal_run_interrupted_requires_review';
    const goalComplete = {
      type: 'goal_complete',
      payload: { status: 'aborted' as const, reason: 'interrupted' },
      recordedAt: now,
    };
    if (this.ports.continuationExecutor === 'unavailable') {
      await this.registry.terminalDurable(plan.envelope.runId, {
        now,
        status: 'failed',
        reason,
        event: goalComplete,
      });
      return { status: 'failed' as const, reason };
    }
    await this.registry.checkpointDurable(plan.envelope.runId, {
      now,
      status: 'waiting',
      state: plan.checkpoint?.state,
      engineCursor: plan.checkpoint?.cursor.engineCursor,
      pendingOperations: plan.pendingOperations,
      childRuns: plan.childRuns,
      events: [goalComplete, { type: 'native_recovery_requires_review', payload: { reason }, recordedAt: now }],
    });
    return { status: 'requires_review' as const, reason };
  }
}

function isTerminalOperation(operation: PendingOperation): boolean {
  return operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'abandoned';
}

function normalizeApprovalResolution(
  value: NativeRecoveryApprovalResolution | NativeRecoveryApprovalStatus,
): NativeRecoveryApprovalResolution {
  return typeof value === 'string' ? { status: value } : value;
}

function replacePendingOperation(
  operations: PendingOperation[],
  operation: PendingOperation,
  updates: Partial<Pick<PendingOperation, 'status' | 'resultRef' | 'requiresHumanConfirmation' | 'updatedAt'>>,
): void {
  const index = operations.findIndex((candidate) => candidate.operationId === operation.operationId);
  if (index < 0) return;
  operations[index] = { ...operations[index], ...updates };
}

function descriptorForOperation(
  base: NativeRecoveryDescriptor,
  operation: PendingOperation,
): NativeRecoveryDescriptor {
  const logicalOperationId = operation.operationId.replace(/^(model|tool):/, '') || base.logicalOperationId;
  const descriptor: NativeRecoveryDescriptor = {
    ...base,
    operationId: operation.operationId,
    logicalOperationId,
    phase: operation.kind === 'tool_call'
      ? 'tool_dispatched'
      : operation.kind === 'approval'
        ? 'approval_waiting'
        : operation.status === 'prepared'
          ? 'before_model_dispatch'
          : 'after_model_dispatch',
  };
  if (operation.kind === 'approval') {
    const approvalId = operation.providerOperationId?.replace(/^approval:/, '');
    if (approvalId) descriptor.approvalId = approvalId;
    else delete descriptor.approvalId;
  } else {
    delete descriptor.approvalId;
  }
  return descriptor;
}

export function createUnavailableNativeRecoveryPorts(): NativeRecoveryHostPorts {
  const unavailable = async (): Promise<never> => { throw new Error('native recovery application dependency unavailable'); };
  return {
    continuationExecutor: 'unavailable',
    resolveWorkspace: async () => ({ ok: false, reason: 'native_workspace_resolver_unavailable' }),
    model: {
      dispatchPrepared: unavailable,
      queryResult: unavailable,
      canRetrySafely: async () => false,
      retrySafe: unavailable,
    },
    tool: {
      queryResult: unavailable,
      classifyReplaySafety: unavailable,
      dispatchPrepared: unavailable,
      interrupt: unavailable,
    },
    approval: { read: async () => 'missing' },
  };
}
