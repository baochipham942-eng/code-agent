// ============================================================================
// delegationAdmission — deterministic admission gates + delivery re-check
// (ADR-072 D3/D4/D5.1, slice K1B)
// ============================================================================
// Pure, synchronous: no DB, no IO, no clock (pass `now` where needed), no
// randomness (secret lives in the caller's candidate snapshot). Callers
// (K1C/K1D) collect facts into a snapshot object and call these functions.
//
// G7 does not exist (folded into G4); G9 is structural (user text comes from
// the ConversationEnvelope trusted channel) and has no runtime code here.
// ============================================================================

import path from 'node:path';
import {
  deriveActionFingerprint,
  deriveSubmissionKey,
  delegationTargetIdentity,
  type DelegationChainAction,
} from './delegationKeys';

export type DelegationRejectionCode =
  | 'target_unavailable'
  | 'not_delegatable'
  | 'self_route'
  | 'candidate_set_stale'
  | 'idempotency_conflict'
  | 'workspace_boundary'
  | 'write_conflict'
  | 'unauthorized_workspace'
  | 'target_busy'
  | 'target_permission_mode'
  | 'untrusted_workspace'
  | 'ambiguous'
  | 'invalid_call';

const DELEGATION_ACTIONS: readonly DelegationChainAction[] = [
  'delegate_existing',
  'create_new',
  'correct',
  'stop',
  'resume',
];

const DELEGATE_ACTIONS: readonly DelegationChainAction[] = ['delegate_existing', 'create_new'];
const CHAIN_ACTIONS: readonly DelegationChainAction[] = ['correct', 'stop', 'resume'];

/** 模型自带会话/身份/工作区键一律 invalid_call（D4）。 */
const FORBIDDEN_KEYS = [
  'sessionId',
  'targetSessionId',
  'workspace',
  'workspaceRoot',
  'workingDirectory',
  'path',
  'paths',
  'cwd',
] as const;

const G11_ALLOWED_MODES: readonly string[] = [
  'default',
  'readOnly',
  'acceptEdits',
  'dontAsk',
  'plan',
];

export interface DelegateSessionCall {
  action: DelegationChainAction;
  /** delegate_existing / create_new 的任务文本。 */
  content?: string;
  /** delegate_existing 的不透明候选引用。 */
  candidateRef?: string;
  /** 模型回显的候选集指纹（可选）。 */
  candidateSetId?: string;
  /** 链上操作的委托行 id。 */
  delegationId?: string;
}

export type ParsedDelegateSessionCall =
  | { ok: true; call: DelegateSessionCall }
  | { ok: false; code: 'invalid_call' | 'ambiguous'; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * D4 调用形状校验：未知 action、多余键、模型自带 sessionId、create_new 带工作区、
 * 链上操作缺 delegationId → invalid_call；delegate_existing 缺 candidateRef → ambiguous。
 */
export function parseDelegateSessionCall(args: unknown): ParsedDelegateSessionCall {
  if (!isPlainObject(args)) {
    return { ok: false, code: 'invalid_call', detail: 'delegate_session arguments must be an object' };
  }
  const action = args.action;
  if (typeof action !== 'string' || !(DELEGATION_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: 'invalid_call', detail: `unknown action: ${String(action)}` };
  }
  const allowed = new Set<string>(['action']);
  if (DELEGATE_ACTIONS.includes(action as DelegationChainAction) || action === 'correct') {
    allowed.add('content');
  }
  if (action === 'delegate_existing') {
    allowed.add('candidateRef');
    allowed.add('candidateSetId');
  }
  if (CHAIN_ACTIONS.includes(action as DelegationChainAction)) {
    allowed.add('delegationId');
  }
  const extraKeys = Object.keys(args).filter((key) => !allowed.has(key));
  if (extraKeys.length > 0) {
    return {
      ok: false,
      code: 'invalid_call',
      detail: `unexpected keys for ${action}: ${extraKeys.join(', ')}`,
    };
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (forbidden in args) {
      return {
        ok: false,
        code: 'invalid_call',
        detail: `model must not provide ${forbidden}`,
      };
    }
  }

  if (DELEGATE_ACTIONS.includes(action as DelegationChainAction)) {
    const content = args.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, code: 'invalid_call', detail: `${action} requires task text` };
    }
    if (action === 'delegate_existing' && !optionalString(args.candidateRef)) {
      return { ok: false, code: 'ambiguous', detail: 'delegate_existing requires a candidateRef' };
    }
    return {
      ok: true,
      call: {
        action: action as DelegationChainAction,
        content,
        ...(optionalString(args.candidateRef) ? { candidateRef: optionalString(args.candidateRef) } : {}),
        ...(optionalString(args.candidateSetId) ? { candidateSetId: optionalString(args.candidateSetId) } : {}),
      },
    };
  }

  if (action === 'correct') {
    const content = args.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, code: 'invalid_call', detail: 'correct requires task text' };
    }
    const delegationId = optionalString(args.delegationId);
    if (!delegationId) return { ok: false, code: 'invalid_call', detail: 'correct requires a delegationId' };
    return { ok: true, call: { action: 'correct', content, delegationId } };
  }

  const delegationId = optionalString(args.delegationId);
  if (!delegationId) {
    return { ok: false, code: 'invalid_call', detail: `${action} requires a delegationId` };
  }
  return {
    ok: true,
    call: { action: action as DelegationChainAction, delegationId },
  };
}

/** G6：path.resolve 后一根等于另一根、或带分隔符前缀，才算重叠。 */
export function workspacesOverlap(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  return a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

interface DelegationFolderTrustSnapshot {
  state: string;
  blockedItems: number;
}

/** G12 评估事实：{error:true} 表示评估抛错或拿不到结果（同样拒绝）。 */
export type DelegationFolderTrustFact =
  | DelegationFolderTrustSnapshot
  | { error: true }
  | null;

interface DelegationTargetSnapshot {
  /** delegate_existing：解析出的目标；create_new：null。 */
  sessionId: string | null;
  sessionExists: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  /** 缺省按 'chat' 判。 */
  sessionType: string;
  /** 缺省按 'native' 判；G2 判据是 !== 'native'，不按已知 kind 列表。 */
  engineKind: string;
  workspaceRoot: string | null;
  /** G5：workspaceScope 可解析且根在授权目录集内。 */
  workspaceAuthorized: boolean;
  /** G11：目标会话生效权限档；无会话（create_new）为 null。 */
  permissionMode: string | null;
  /** G12：目标/新工作区的 folderTrust 评估。 */
  folderTrust: DelegationFolderTrustFact;
}

interface DelegationCandidateSetSnapshot {
  candidateSetId: string;
  /** host 内部：与 candidates 同序的不透明 ref。 */
  candidateRefs: readonly string[];
  /** host 内部：与 candidateRefs 平行的 session id。 */
  candidateSessionIds: readonly string[];
}

export interface DelegationAdmissionSnapshot {
  originSessionId: string;
  originTurnId: string;
  /** G8：host 受信通道给出的新工作区根（create_new 用）。 */
  hostWorkspaceRoot?: string;
  /** 当前候选集快照（delegate_existing 的 G3/ambiguous 解析输入）。 */
  candidates?: DelegationCandidateSetSnapshot;
  target: DelegationTargetSnapshot;
  /** G6：正在跑的轮（含用户直开会话；发起会话自身不算——它就是调用方）。 */
  runningTurns: ReadonlyArray<{ sessionId: string; workspaceRoot: string | null }>;
  /** G10：目标上的活跃 run id（无则 null）。 */
  targetActiveRunId: string | null;
  /** 指向该目标的委托行的 target_run_id 集合（G10/INV-2 区分用户与委托占用）。 */
  delegatedRunIds: ReadonlyArray<string>;
  /** G10：目标上用户来源的 queued/sending 行数（任意位置）。 */
  userQueuedOrSendingRows: number;
  /** G4：同 submission_key 的既有委托行（host 按 key 查好传入）。 */
  existingDelegation: {
    delegationId: string;
    originSessionId: string;
    targetSessionId: string;
    actionFingerprint: string;
    status: string;
  } | null;
  /** 链上操作：按 call.delegationId 查到的委托行（存在性与归属在这里判）。 */
  chainDelegation?: {
    delegationId: string;
    originSessionId: string;
    targetSessionId: string;
    status: string;
  } | null;
}

export type DelegationAdmissionResult =
  | {
    kind: 'admitted';
    targetSessionId: string | null;
    submissionKey: string;
    actionFingerprint: string;
    delegationId?: string;
  }
  | { kind: 'reused'; delegationId: string }
  | { kind: 'rejected'; code: DelegationRejectionCode; gate: string; detail: string };

function rejected(code: DelegationRejectionCode, gate: string, detail: string) {
  return { kind: 'rejected' as const, code, gate, detail };
}

/** G1：目标会话存在且未归档未删除（create_new 无会话行，跳过）。 */
function checkG1(target: DelegationTargetSnapshot): string | null {
  if (!target.sessionExists || target.isArchived || target.isDeleted) {
    return 'target session is missing, archived, or deleted';
  }
  return null;
}

/** G2：非发起会话自身、session_type 白名单、引擎 kind 必须是 native（origin 缺省跳过 self 判）。 */
function checkG2(target: DelegationTargetSnapshot, originSessionId: string | null): string | null {
  if (originSessionId !== null && target.sessionId !== null && target.sessionId === originSessionId) {
    return 'target is the origin session itself';
  }
  const sessionType = target.sessionType || 'chat';
  if (sessionType !== 'chat') {
    return `session type ${sessionType} is not delegatable`;
  }
  const engineKind = target.engineKind || 'native';
  if (engineKind !== 'native') {
    return `engine kind ${engineKind} is not delegatable`;
  }
  return null;
}

/** G5：workspaceScope 可解析（根非空）且在授权目录集内。 */
function checkG5(target: DelegationTargetSnapshot): string | null {
  if (target.workspaceRoot === null || !target.workspaceAuthorized) {
    return 'target workspace scope is unresolvable or outside authorized roots';
  }
  return null;
}

/** G6：目标工作区不得与其他会话正在跑的轮重叠（发起会话与目标会话自身的轮除外）。 */
function checkG6(
  snapshot: DelegationAdmissionSnapshot,
  targetSessionId: string | null,
): string | null {
  for (const turn of snapshot.runningTurns) {
    if (turn.sessionId === snapshot.originSessionId) continue;
    if (targetSessionId !== null && turn.sessionId === targetSessionId) continue;
    if (workspacesOverlap(snapshot.target.workspaceRoot, turn.workspaceRoot)) {
      return `target workspace overlaps the running turn of session ${turn.sessionId}`;
    }
  }
  return null;
}

/** G8：create_new 的工作区必须来自 host 受信通道。 */
function checkG8(snapshot: DelegationAdmissionSnapshot, action: DelegationChainAction): string | null {
  if (action !== 'create_new') return null;
  if (!snapshot.hostWorkspaceRoot) {
    return 'create_new requires a host-provided workspace root';
  }
  return null;
}

/** G10：目标没被用户占用（活跃 run 对不上任何委托行、无用户来源排队行）。 */
function checkG10(snapshot: DelegationAdmissionSnapshot, targetSessionId: string | null): string | null {
  if (targetSessionId === null) return null;
  const activeRun = snapshot.targetActiveRunId;
  if (activeRun && !snapshot.delegatedRunIds.includes(activeRun)) {
    return 'target session has an active user-originated run';
  }
  if (snapshot.userQueuedOrSendingRows > 0) {
    return 'target session has user-originated queued or sending inputs';
  }
  return null;
}

/** G11：目标权限档不得高于 acceptEdits（allowlist 外一律拒，含未知档）。 */
function checkG11(target: DelegationTargetSnapshot): string | null {
  if (target.permissionMode === null) return null;
  if (!G11_ALLOWED_MODES.includes(target.permissionMode)) {
    return `target permission mode ${target.permissionMode} exceeds the delegation ceiling`;
  }
  return null;
}

/** G12：评估缺失/抛错，或非 trusted 且有 blocked 项 → 拒（未知即拒）。 */
function checkG12(target: DelegationTargetSnapshot): string | null {
  const trust = target.folderTrust;
  if (!trust || 'error' in trust) {
    return 'folder trust evaluation is missing or failed';
  }
  if (trust.state !== 'trusted' && trust.blockedItems > 0) {
    return `workspace is ${trust.state} with ${trust.blockedItems} blocked items`;
  }
  return null;
}

/**
 * 准入门。求值顺序（先红先赢）：调用形状（parseDelegateSessionCall）→ 候选解析
 * （G3 candidate_set_stale，再 ambiguous）→ G4 → G1 → G2 → G5 → G6 → G8 →
 * G10 → G11 → G12。G4 排在门首：幂等重试即使目标已忙也返回 reused。
 */
export function admitDelegation(
  call: DelegateSessionCall,
  snapshot: DelegationAdmissionSnapshot,
): DelegationAdmissionResult {
  if (CHAIN_ACTIONS.includes(call.action)) {
    return admitChainOperation(call, snapshot);
  }

  let targetSessionId: string | null = null;
  if (call.action === 'delegate_existing') {
    const candidates = snapshot.candidates;
    if (!candidates) {
      return rejected('ambiguous', 'G3', 'candidate set is unavailable');
    }
    if (call.candidateSetId && call.candidateSetId !== candidates.candidateSetId) {
      return rejected('candidate_set_stale', 'G3', 'candidateRef belongs to an older candidate set');
    }
    const index = candidates.candidateRefs.indexOf(call.candidateRef ?? '');
    if (index < 0) {
      return rejected('ambiguous', 'G3', 'candidateRef matches no candidate in the current set');
    }
    targetSessionId = candidates.candidateSessionIds[index] ?? null;
  }

  const targetIdentity = delegationTargetIdentity({
    action: call.action,
    sessionId: targetSessionId ?? undefined,
    hostWorkspaceRoot: snapshot.hostWorkspaceRoot,
  });
  const submissionKey = deriveSubmissionKey({
    originSessionId: snapshot.originSessionId,
    originTurnId: snapshot.originTurnId,
    action: call.action,
    targetIdentity,
  });
  const actionFingerprint = deriveActionFingerprint({
    action: call.action,
    targetIdentity,
    content: call.content ?? '',
    attachmentRefs: [],
  });

  const existing = snapshot.existingDelegation;
  if (existing) {
    return existing.actionFingerprint === actionFingerprint
      ? { kind: 'reused', delegationId: existing.delegationId }
      : rejected('idempotency_conflict', 'G4', 'same submission key with a different payload');
  }

  if (call.action === 'delegate_existing') {
    const g1 = checkG1(snapshot.target);
    if (g1) return rejected('target_unavailable', 'G1', g1);
  }
  const g2 = checkG2(snapshot.target, snapshot.originSessionId);
  if (g2) {
    return rejected(
      (snapshot.target.sessionId !== null && snapshot.target.sessionId === snapshot.originSessionId)
        ? 'self_route'
        : 'not_delegatable',
      'G2',
      g2,
    );
  }
  const g5 = checkG5(snapshot.target);
  if (g5) return rejected('workspace_boundary', 'G5', g5);
  const g6 = checkG6(snapshot, targetSessionId);
  if (g6) return rejected('write_conflict', 'G6', g6);
  const g8 = checkG8(snapshot, call.action);
  if (g8) return rejected('unauthorized_workspace', 'G8', g8);
  const g10 = checkG10(snapshot, targetSessionId);
  if (g10) return rejected('target_busy', 'G10', g10);
  const g11 = checkG11(snapshot.target);
  if (g11) return rejected('target_permission_mode', 'G11', g11);
  const g12 = checkG12(snapshot.target);
  if (g12) return rejected('untrusted_workspace', 'G12', g12);

  return {
    kind: 'admitted',
    targetSessionId,
    submissionKey,
    actionFingerprint,
  };
}

function admitChainOperation(
  call: DelegateSessionCall,
  snapshot: DelegationAdmissionSnapshot,
): DelegationAdmissionResult {
  const chain = snapshot.chainDelegation;
  if (!chain || chain.delegationId !== call.delegationId) {
    return rejected('invalid_call', 'chain', 'delegation row not found for the chain operation');
  }
  if (chain.originSessionId !== snapshot.originSessionId) {
    return rejected('invalid_call', 'chain', 'delegation row belongs to a different origin session');
  }
  const requiredStatus = call.action === 'resume' ? 'stopped' : 'active';
  if (chain.status !== requiredStatus) {
    return rejected('invalid_call', 'chain', `${call.action} requires status ${requiredStatus}, got ${chain.status}`);
  }

  const targetIdentity = delegationTargetIdentity({ action: call.action, delegationId: call.delegationId });
  const submissionKey = deriveSubmissionKey({
    originSessionId: snapshot.originSessionId,
    originTurnId: snapshot.originTurnId,
    action: call.action,
    targetIdentity,
  });
  const actionFingerprint = deriveActionFingerprint({
    action: call.action,
    targetIdentity,
    content: call.content ?? '',
    attachmentRefs: [],
  });

  if (call.action === 'correct' || call.action === 'resume') {
    const g1 = checkG1(snapshot.target);
    if (g1) return rejected('target_unavailable', 'G1', g1);
    const g2 = checkG2(snapshot.target, snapshot.originSessionId);
    if (g2) {
      return rejected(
        (snapshot.target.sessionId !== null && snapshot.target.sessionId === snapshot.originSessionId)
          ? 'self_route'
          : 'not_delegatable',
        'G2',
        g2,
      );
    }
    const g11 = checkG11(snapshot.target);
    if (g11) return rejected('target_permission_mode', 'G11', g11);
    const g12 = checkG12(snapshot.target);
    if (g12) return rejected('untrusted_workspace', 'G12', g12);
  }

  return {
    kind: 'admitted',
    targetSessionId: chain.targetSessionId,
    submissionKey,
    actionFingerprint,
    delegationId: chain.delegationId,
  };
}

export interface DelegationDeliverySnapshot {
  target: DelegationTargetSnapshot;
  /** 委托行的 origin_session_id（self_route 复核用）。 */
  originSessionId: string | null;
  /** 目标会话当前的活跃 run id（无则 null）。 */
  activeRunId: string | null;
  /** 指向该目标的委托行的 target_run_id 集合。 */
  delegatedRunIds: ReadonlyArray<string>;
  /** 排在本行之前、用户来源且 queued(可投)/sending 的行数。 */
  userRowsAhead: number;
}

export type DelegationDeliveryDecision =
  | { kind: 'deliver' }
  | { kind: 'wait' }
  | { kind: 'pause'; code: DelegationRejectionCode; gate: string; detail: string };

/**
 * 投递复核（INV-2）：G1、G2、G11、G12 + 占用三句话——
 * ① 排在本行之后的输入不算忙（本函数只收「之前的」行数，天然满足）；
 * ② 活跃 run 的 id 对得上另一条委托的 target_run_id → wait（排队，不是冲突）；
 * ③ 对不上任何委托行的活跃 run，或之前的用户来源可投/发送中行 → pause target_busy。
 */
export function recheckForDelivery(snapshot: DelegationDeliverySnapshot): DelegationDeliveryDecision {
  const g1 = checkG1(snapshot.target);
  if (g1) return { kind: 'pause', code: 'target_unavailable', gate: 'G1', detail: g1 };
  const g2 = checkG2(snapshot.target, snapshot.originSessionId);
  if (g2) return { kind: 'pause', code: 'not_delegatable', gate: 'G2', detail: g2 };
  const g11 = checkG11(snapshot.target);
  if (g11) return { kind: 'pause', code: 'target_permission_mode', gate: 'G11', detail: g11 };
  const g12 = checkG12(snapshot.target);
  if (g12) return { kind: 'pause', code: 'untrusted_workspace', gate: 'G12', detail: g12 };

  const activeRunId = snapshot.activeRunId;
  if (activeRunId) {
    if (snapshot.delegatedRunIds.includes(activeRunId)) {
      return { kind: 'wait' };
    }
    return {
      kind: 'pause',
      code: 'target_busy',
      gate: 'INV-2',
      detail: 'target session has an active run that belongs to no delegation',
    };
  }
  if (snapshot.userRowsAhead > 0) {
    return {
      kind: 'pause',
      code: 'target_busy',
      gate: 'INV-2',
      detail: `${snapshot.userRowsAhead} user-originated row(s) ahead of this one`,
    };
  }
  return { kind: 'deliver' };
}
