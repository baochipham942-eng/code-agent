import type { ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import type { ConversationEnvelope } from '../../../../shared/contract/conversationEnvelope';
import type { ModelConfig } from '../../../../shared/contract/model';
import { QueuedInputRepository } from '../../../services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository, type SessionDelegationRecord } from '../../../services/core/repositories/SessionDelegationRepository';
import {
  commitDelegation,
  collectDeliveryFacts,
  type DelegationDeliveryFactDependencies,
} from '../../../services/delegation/delegationDelivery';
import {
  admitDelegation,
  parseDelegateSessionCall,
  type DelegationAdmissionSnapshot,
  type DelegationAdmissionResult,
  type DelegateSessionCall,
} from '../../../services/delegation/delegationAdmission';
import { deriveActionFingerprint, deriveSubmissionKey, delegationTargetIdentity } from '../../../services/delegation/delegationKeys';
import { projectSessionCandidates, resolveCandidateRef } from '../../../services/delegation/delegationCandidates';
import { getDelegationCandidateSecret, getDelegationToolRuntime, workspaceWithinRoots } from '../../../services/delegation/delegationToolRuntime';
import { isCrossSessionDelegationEnabled } from '../../../services/delegation/crossSessionDelegationFlag';
import { delegateSessionSchema as schema } from './delegateSession.schema';

const REJECTION_SUFFIX = ' Nothing was delegated. Ask the user with AskUserQuestion; do not retry with create_new.';

function rejection(code: string, detail: string): ToolResult<string> {
  return { ok: false, code: 'DELEGATION_REJECTED', error: `${code}: ${detail}.${REJECTION_SUFFIX}` };
}

function successfulOutput(input: { delegationId: string; targetName: string; queuedAhead: number }): ToolResult<string> {
  return {
    ok: true,
    output: JSON.stringify({ delegationId: input.delegationId, target: input.targetName, status: 'active', queuedAhead: input.queuedAhead }),
    meta: { delegationId: input.delegationId, target: input.targetName, status: 'active', queuedAhead: input.queuedAhead },
  };
}

function modelConfigOf(value: unknown): ModelConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const provider = (value as { provider?: unknown }).provider;
  const model = (value as { model?: unknown }).model;
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}

function envelopeFrom(row: SessionDelegationRecord, db: Parameters<typeof commitDelegation>[0]): ConversationEnvelope | null {
  if (!row.targetQueuedInputId) return null;
  const queued = new QueuedInputRepository(db).getById(row.targetQueuedInputId);
  if (!queued) return null;
  try {
    return JSON.parse(queued.envelopeJson) as ConversationEnvelope;
  } catch {
    return null;
  }
}

function isQueuedRow(row: SessionDelegationRecord, db: Parameters<typeof commitDelegation>[0]): boolean {
  return Boolean(row.targetQueuedInputId && new QueuedInputRepository(db).getById(row.targetQueuedInputId)?.status === 'queued');
}

async function buildSnapshot(
  call: DelegateSessionCall,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
  targetSessionId: string | null,
  candidateSet: ReturnType<typeof projectSessionCandidates> | undefined,
  hostWorkspaceRoot: string | undefined,
  existingDelegation: DelegationAdmissionSnapshot['existingDelegation'],
  chainDelegation?: DelegationAdmissionSnapshot['chainDelegation'],
): Promise<DelegationAdmissionSnapshot> {
  const target = targetSessionId ? runtime.getSessionRow(targetSessionId) : null;
  const targetWorkspace = target?.workingDirectory?.trim() || (call.action === 'create_new' ? hostWorkspaceRoot ?? null : null);
  let folderTrust: DelegationAdmissionSnapshot['target']['folderTrust'] = null;
  if (targetWorkspace) {
    try {
      const evaluated = await runtime.evaluateFolderTrust(targetWorkspace);
      folderTrust = { state: evaluated.state, blockedItems: evaluated.blockedItems };
    } catch {
      folderTrust = { error: true };
    }
  }
  const roots = [...runtime.getWorkspaceRoots(), ...(ctx.workspaceScope?.roots.map((root) => root.path) ?? [])];
  const runs = runtime.getRuns();
  const db = runtime.getDb();
  const delegatedRunIds = targetSessionId && db
    ? new SessionDelegationRepository(db).listByTargetSession(targetSessionId).flatMap((row) => row.targetRunId ? [row.targetRunId] : [])
    : [];
  let userQueuedOrSendingRows = 0;
  if (targetSessionId && db) {
    const queued = new QueuedInputRepository(db).listBySession(targetSessionId);
    const delegations = new SessionDelegationRepository(db);
    userQueuedOrSendingRows = queued.filter((row) =>
      (row.status === 'queued' && row.pausedReason === null || row.status === 'sending')
      && delegations.getByTargetQueuedInputId(row.id) === null,
    ).length;
  }
  return {
    originSessionId: ctx.sessionId,
    originTurnId: ctx.turnId ?? 'unknown-turn',
    ...(hostWorkspaceRoot ? { hostWorkspaceRoot } : {}),
    ...(candidateSet ? {
      candidates: {
        candidateSetId: candidateSet.candidateSetId,
        candidateRefs: candidateSet.candidates.map((candidate) => candidate.candidateRef),
        candidateSessionIds: candidateSet.sessionIds,
      },
    } : {}),
    target: {
      sessionId: targetSessionId,
      sessionExists: call.action === 'create_new' ? true : target !== null,
      isArchived: target?.isArchived === true,
      isDeleted: target?.isDeleted === true,
      sessionType: target?.sessionType ?? 'chat',
      engineKind: target?.engineKind ?? 'native',
      workspaceRoot: targetWorkspace,
      workspaceAuthorized: workspaceWithinRoots(targetWorkspace, roots),
      permissionMode: targetSessionId ? runtime.getPermissionMode(targetSessionId) : runtime.getPermissionMode(ctx.sessionId),
      folderTrust,
    },
    runningTurns: runs.map((run) => ({ sessionId: run.context.sessionId, workspaceRoot: run.context.workspace ?? null })),
    targetActiveRunId: targetSessionId ? runtime.getRun(targetSessionId)?.context.runId ?? null : null,
    delegatedRunIds,
    userQueuedOrSendingRows,
    existingDelegation,
    ...(chainDelegation ? { chainDelegation } : {}),
  };
}

function parseArgs(args: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...args };
  if (typeof args.text === 'string' && args.content === undefined) normalized.content = args.text;
  delete normalized.text;
  return parseDelegateSessionCall(normalized);
}

type AdmissionOutcome = {
  result: DelegationAdmissionResult;
  row: SessionDelegationRecord | null;
  targetSessionId?: string | null;
  targetIdentity?: string;
  snapshot?: DelegationAdmissionSnapshot;
};
type AdmittedOutcome = AdmissionOutcome & {
  result: Extract<DelegationAdmissionResult, { kind: 'admitted' }>;
  snapshot: DelegationAdmissionSnapshot;
};

async function admissionFor(
  call: DelegateSessionCall,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<AdmissionOutcome> {
  let projection: ReturnType<typeof projectSessionCandidates> | undefined;
  let targetSessionId: string | null = null;
  const secret = getDelegationCandidateSecret();
  if (call.action === 'delegate_existing') {
    projection = projectSessionCandidates(runtime.listSessions(), {
      originSessionId: ctx.sessionId,
      now: runtime.now(),
      secret,
      isRunning: (sessionId) => runtime.getRun(sessionId) !== undefined,
    });
    const resolved = resolveCandidateRef({ candidateSetId: call.candidateSetId, candidateRef: call.candidateRef }, projection, secret);
    if (!resolved.ok) {
      return {
        result: { kind: 'rejected', code: resolved.code, gate: 'G3', detail: 'candidate reference is stale or ambiguous' },
        row: null,
      };
    }
    targetSessionId = resolved.sessionId;
    if (call.candidateSetId && call.candidateSetId !== projection.candidateSetId) {
      return {
        result: { kind: 'rejected', code: 'candidate_set_stale', gate: 'G3', detail: 'candidate set is stale' },
        row: null,
      };
    }
  }
  if (call.action === 'create_new') targetSessionId = null;
  if (call.action === 'correct' || call.action === 'stop' || call.action === 'resume') {
    const db = runtime.getDb();
    const row = db ? new SessionDelegationRepository(db).get(call.delegationId ?? '') : null;
    const chain = row && {
      delegationId: row.delegationId,
      originSessionId: row.originSessionId,
      targetSessionId: row.targetSessionId,
      status: row.status,
    };
    targetSessionId = row?.targetSessionId ?? null;
    const snapshot = await buildSnapshot(call, ctx, runtime, targetSessionId, undefined, undefined, null, chain ?? undefined);
    return { result: admitDelegation(call, snapshot), row, targetSessionId, snapshot };
  }
  const targetIdentity = delegationTargetIdentity({ action: call.action, sessionId: targetSessionId ?? undefined, hostWorkspaceRoot: ctx.workspaceScope?.primaryRoot ?? ctx.workspace });
  const db = runtime.getDb();
  const existing = db ? new SessionDelegationRepository(db).getBySubmissionKey(deriveSubmissionKey({
    originSessionId: ctx.sessionId,
    originTurnId: ctx.turnId ?? 'unknown-turn',
    action: call.action,
    targetIdentity,
  })) : null;
  const snapshot = await buildSnapshot(call, ctx, runtime, targetSessionId, projection, call.action === 'create_new' ? ctx.workspaceScope?.primaryRoot ?? ctx.workspace : undefined, existing ? {
    delegationId: existing.delegationId,
    originSessionId: existing.originSessionId,
    targetSessionId: existing.targetSessionId,
    actionFingerprint: existing.actionFingerprint,
    status: existing.status,
  } : null);
  return { result: admitDelegation(call, snapshot), row: existing, targetSessionId, targetIdentity, snapshot };
}

export async function executeDelegateSession(
  args: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1],
  canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
): Promise<ToolResult<string>> {
  if (!isCrossSessionDelegationEnabled()) return { ok: false, code: 'FEATURE_DISABLED', error: 'cross-session delegation is disabled' };
  const permission = await canUseTool(schema.name, args);
  if (!permission.allow) return { ok: false, code: 'PERMISSION_DENIED', error: permission.reason };
  const parsed = parseArgs(args);
  if (!parsed.ok) return rejection(parsed.code, parsed.detail);
  const runtime = getDelegationToolRuntime(ctx);
  const call = parsed.call;
  try {
    const admission = await admissionFor(call, ctx, runtime);
    if (admission.result.kind === 'rejected') return rejection(admission.result.code, admission.result.detail);
    if (admission.result.kind === 'reused') {
      const row = admission.row;
      return successfulOutput({ delegationId: admission.result.delegationId, targetName: runtime.getSessionRow(row?.targetSessionId ?? '')?.title ?? 'session', queuedAhead: 0 });
    }
    if (call.action === 'stop' || call.action === 'resume' || call.action === 'correct') {
      return executeChain(call, admission.row ?? null, ctx, runtime);
    }
    if (admission.result.kind !== 'admitted' || !admission.snapshot) return rejection('invalid_call', 'admission did not produce a delegation');
    return executeNewDelegation(call, admission as AdmittedOutcome, ctx, runtime);
  } catch (error) {
    return rejection('invalid_call', error instanceof Error ? error.message : 'delegation host operation failed');
  }
}

async function executeNewDelegation(
  call: DelegateSessionCall,
  admission: AdmittedOutcome,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<ToolResult<string>> {
  const db = runtime.getDb();
  if (!db) return rejection('target_unavailable', 'database is unavailable');
  const targetId = admission.result.targetSessionId ?? runtime.randomId('session_');
  const target = runtime.getSessionRow(targetId);
  const targetName = target?.title ?? (call.action === 'create_new' ? (call.content?.trim().slice(0, 40) || 'new session') : 'session');
  const envelope: ConversationEnvelope = {
    content: call.content ?? '',
    sessionId: targetId,
    options: target?.modelConfig || modelConfigOf(ctx.modelConfig) ? { modelSpec: target?.modelConfig ?? modelConfigOf(ctx.modelConfig) } : undefined,
  };
  const delegationId = runtime.randomId('delegation_');
  const input = {
    delegationId,
    originSessionId: ctx.sessionId,
    originTurnId: ctx.turnId ?? 'unknown-turn',
    disposition: call.action as 'delegate_existing' | 'create_new',
    targetSessionId: targetId,
    submissionKey: admission.result.submissionKey,
    actionFingerprint: admission.result.actionFingerprint,
    envelope,
    now: runtime.now(),
  } as const;
  let committed;
  if (call.action === 'create_new') {
    const manager = runtime.getSessionManager();
    const modelConfig = modelConfigOf(ctx.modelConfig);
    if (!modelConfig) return rejection('invalid_call', 'create_new requires a host model configuration');
    await manager.createSession({
      id: targetId,
      title: call.content?.slice(0, 80) || 'Delegated session',
      modelConfig,
      workingDirectory: ctx.workspaceScope?.primaryRoot ?? ctx.workspace,
      commit: (write) => { committed = commitDelegation(db, input, write); },
    });
  } else {
    committed = commitDelegation(db, input);
  }
  if (!committed) return rejection('target_unavailable', 'delegation transaction did not commit');
  // rework r2：同轮并行提交撞 submission_key 且指纹不同（G4 的竞态形态）——
  // 新正文没有入队，绝不能回 status:active 的成功回执，否则第二个任务被静默
  // 丢弃且模型不会重试。与非竞态 G4 拒绝保持同一形状。
  if (committed.kind === 'idempotency_conflict') {
    return rejection('idempotency_conflict', 'same submission key with a different payload');
  }
  runtime.notifyEnqueued(targetId);
  return successfulOutput({ delegationId: committed.delegationId, targetName, queuedAhead: admission.snapshot.userQueuedOrSendingRows });
}

async function executeChain(
  call: DelegateSessionCall,
  row: SessionDelegationRecord | null,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<ToolResult<string>> {
  const db = runtime.getDb();
  if (!db || !row) return rejection('invalid_call', 'delegation row is missing');
  const repository = new SessionDelegationRepository(db);
  const queued = new QueuedInputRepository(db);
  const now = runtime.now();
  if (call.action === 'stop') {
    if (row.targetQueuedInputId && isQueuedRow(row, db)) queued.pauseQueued(row.targetQueuedInputId, 'delegation_stopped', now);
    const handle = runtime.getRun(row.targetSessionId);
    if (handle?.cancel && row.targetRunId && handle.context.runId === row.targetRunId) await handle.cancel('user');
    repository.markStopped(row.delegationId, { reason: 'user' }, now);
    return successfulOutput({ delegationId: row.delegationId, targetName: runtime.getSessionRow(row.targetSessionId)?.title ?? 'session', queuedAhead: 0 });
  }
  if (call.action === 'resume') {
    if (!row.targetQueuedInputId) return rejection('invalid_call', 'delegation has no queued input');
    const targetRecord = queued.getById(row.targetQueuedInputId);
    if (!targetRecord) return rejection('invalid_call', 'queued input is missing');
    // rework r1：resume 只复活还能投的行。retracted/failed 行永远不进
    // getNextDispatchable，早拒才能避免「报成功但任务静默丢失、账本滞留 active」。
    if (targetRecord.status !== 'queued') {
      const hint = targetRecord.status === 'failed'
        ? 'requeue the row first, then resume'
        : targetRecord.status === 'sending'
          ? 'wait for the in-flight delivery to settle, then resume'
          : 'a retracted input cannot be revived; delegate the task again';
      return rejection('invalid_call', `queued input is ${targetRecord.status}, not queued; ${hint}`);
    }
    const deps: DelegationDeliveryFactDependencies = {
      getDb: runtime.getDb,
      getSessionRow: runtime.getSessionRow,
      getPermissionMode: runtime.getPermissionMode,
      evaluateFolderTrust: runtime.evaluateFolderTrust,
      getActiveRunId: (sessionId) => runtime.getRun(sessionId)?.context.runId ?? null,
    };
    const facts = await collectDeliveryFacts(deps, { sessionId: row.targetSessionId, queuedInputId: row.targetQueuedInputId, originSessionId: row.originSessionId });
    const delivery = (await import('../../../services/delegation/delegationAdmission')).recheckForDelivery(facts.snapshot);
    if (delivery.kind !== 'deliver') return rejection(delivery.kind === 'pause' ? delivery.code : 'target_busy', delivery.kind === 'wait' ? 'another delegation is running' : delivery.detail);
    queued.unpauseQueued(row.targetQueuedInputId, now);
    repository.markResumed(row.delegationId, now);
    runtime.notifyEnqueued(row.targetSessionId);
    return successfulOutput({ delegationId: row.delegationId, targetName: runtime.getSessionRow(row.targetSessionId)?.title ?? 'session', queuedAhead: 0 });
  }
  if (call.action === 'correct') {
    if (!call.content) return rejection('invalid_call', 'correct requires task text');
    const oldEnvelope = envelopeFrom(row, db);
    const newTarget = row.targetSessionId;
    const target = runtime.getSessionRow(newTarget);
    const targetIdentity = `session:${newTarget}`;
    const submissionKey = deriveSubmissionKey({ originSessionId: ctx.sessionId, originTurnId: ctx.turnId ?? 'unknown-turn', action: 'correct', targetIdentity: `delegation:${row.delegationId}` });
    // The new queue row is a normal delegate_existing delivery; its stored
    // disposition must match the fingerprint used by K1C at delivery time.
    const actionFingerprint = deriveActionFingerprint({ action: 'delegate_existing', targetIdentity, content: call.content, attachmentRefs: [] });
    const newId = runtime.randomId('delegation_');
    const envelope: ConversationEnvelope = { ...(oldEnvelope ?? { sessionId: newTarget }), content: call.content, sessionId: newTarget, options: target?.modelConfig ? { modelSpec: target.modelConfig } : oldEnvelope?.options };
    const committed = commitDelegation(db, { delegationId: newId, originSessionId: ctx.sessionId, originTurnId: ctx.turnId ?? 'unknown-turn', disposition: 'delegate_existing', targetSessionId: newTarget, submissionKey, actionFingerprint, envelope, supersedesDelegationId: row.delegationId, now }, undefined);
    // rework r2：correct 与新委托共用提交缝，竞态撞键同样不得回成功；输家在
    // 赢家已完成的撤回/supersede 副作用之前早退。
    if (committed.kind === 'idempotency_conflict') {
      return rejection('idempotency_conflict', 'same submission key with a different payload');
    }
    if (row.targetQueuedInputId && isQueuedRow(row, db)) queued.retract(row.targetQueuedInputId, now);
    repository.markSuperseded(row.delegationId, now);
    runtime.notifyEnqueued(newTarget);
    return successfulOutput({ delegationId: committed.delegationId, targetName: target?.title ?? 'session', queuedAhead: 0 });
  }
  return rejection('invalid_call', 'unsupported chain action');
}

class DelegateSessionHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(...args: Parameters<ToolHandler<Record<string, unknown>, string>['execute']>) {
    return executeDelegateSession(...args);
  }
}

export const delegateSessionModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new DelegateSessionHandler(),
};
