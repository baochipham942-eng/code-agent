// ============================================================================
// delegationKeys — deterministic key derivation for cross-session delegation
// (ADR-072 D3 G4 / D5, slice K1B)
// ============================================================================
// Pure, synchronous, node:crypto only. Same input -> byte-identical output.
// Callers collect facts; these functions never read the clock, the DB, or IO.
// ============================================================================

import { createHash } from 'node:crypto';

/** submission_key 前缀：一眼可辨这是委托幂等键，不是 renderer 自选 id。 */
const SUBMISSION_KEY_PREFIX = 'sdk_';

/** submission_key 取 sha256 的前 32 个 hex 字符（128 bit，足够防碰撞）。 */
const SUBMISSION_KEY_HEX_LENGTH = 32;

const FIELD_SEPARATOR = '\0';

export type DelegationChainAction =
  | 'delegate_existing'
  | 'create_new'
  | 'correct'
  | 'stop'
  | 'resume';

/** targetIdentity 三种形态（ADR-072 D5 keys）：已有会话 / 新工作区 / 链上操作。 */
export function delegationTargetIdentity(input: {
  action: DelegationChainAction;
  sessionId?: string;
  hostWorkspaceRoot?: string;
  delegationId?: string;
}): string {
  switch (input.action) {
    case 'delegate_existing':
      return `session:${input.sessionId ?? ''}`;
    case 'create_new':
      return `new:${input.hostWorkspaceRoot ?? ''}`;
    case 'correct':
    case 'stop':
    case 'resume':
      return `delegation:${input.delegationId ?? ''}`;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function joined(...fields: string[]): string {
  return fields.join(FIELD_SEPARATOR);
}

/**
 * 排序键 canonical JSON：对象键按字典序、无空白。用于载荷指纹，保证同载荷
 * （不论字段书写顺序）逐字节同输出。
 */
function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonical(item)}`).join(',')}}`;
}

/** 载荷指纹的附件引用：只收 id/path，不含字节，不含 options.modelSpec（INV-5）。 */
export interface DelegationAttachmentRef {
  id: string;
  path: string | null;
}

/**
 * submission_key = 'sdk_' + 前 32 hex of
 *   sha256(originSessionId \0 originTurnId \0 action \0 targetIdentity)。
 * 同发起轮同目标同动作 → 同 key；改了正文 → 同 key 不同 fingerprint。
 */
export function deriveSubmissionKey(input: {
  originSessionId: string;
  originTurnId: string;
  action: DelegationChainAction;
  targetIdentity: string;
}): string {
  const digest = sha256Hex(joined(
    input.originSessionId,
    input.originTurnId,
    input.action,
    input.targetIdentity,
  ));
  return SUBMISSION_KEY_PREFIX + digest.slice(0, SUBMISSION_KEY_HEX_LENGTH);
}

/**
 * action_fingerprint = sha256(action \0 targetIdentity \0
 *   canonicalJson({content, attachmentRefs}))，attachmentRefs 按 id 再 path 排序。
 * options.modelSpec 排除（INV-5）：宿主在入队与重发时按目标当前模型档重写它。
 */
export function deriveActionFingerprint(input: {
  action: DelegationChainAction;
  targetIdentity: string;
  content: string;
  attachmentRefs: readonly DelegationAttachmentRef[];
}): string {
  const attachmentRefs = [...input.attachmentRefs]
    .map((ref) => ({ id: String(ref.id), path: ref.path === undefined ? null : ref.path }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1
      : (left.path ?? '') < (right.path ?? '') ? -1 : (left.path ?? '') > (right.path ?? '') ? 1 : 0));
  const payload = canonicalJson({ content: input.content, attachmentRefs });
  return sha256Hex(joined(input.action, input.targetIdentity, payload));
}

/** 从 envelope 附件提取指纹引用（id / path，缺 path 记 null）。 */
export function attachmentRefsOf(
  attachments: readonly { id?: unknown; path?: unknown }[] | undefined,
): DelegationAttachmentRef[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((item): item is { id?: unknown; path?: unknown } =>
      typeof item === 'object' && item !== null)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      path: typeof item.path === 'string' ? item.path : null,
    }))
    .filter((ref) => ref.id !== '');
}
