import type {
  ConversationBranchEventType,
  ConversationReplayMessage,
} from '../../../../shared/contract/conversationBranch';
import { canonicalJson, deepPortableClone, portabilityDigest } from './canonical';
import {
  PORTABLE_CONVERSATION_HISTORY_SCHEMA,
  PORTABLE_CONVERSATION_HISTORY_VERSION,
  PortableConversationHistoryError,
  SUPPORTED_CONVERSATION_HISTORY_EVENTS as SUPPORTED_EVENTS,
  type ConversationHistorySourceRow as SourceRow,
  type ConversationHistorySourceRows,
  type PortableConversationArtifactProvenance,
  type PortableConversationAttachmentProvenance,
  type PortableConversationBranch,
  type PortableConversationEntry,
  type PortableConversationEvaluationAttribution,
  type PortableConversationEvent,
  type PortableConversationHistoryErrorCode,
  type PortableConversationHistoryV1,
  type PortableConversationReference,
} from './conversationHistoryTypes';

export * from './conversationHistoryTypes';

const ALIAS_KINDS = new Set<ConversationReplayMessage['aliasKind']>([
  'native',
  'fork_copy',
  'legacy_backfill',
  'revision',
  'replacement',
]);

const FORBIDDEN_STRUCTURAL_KEYS = new Set([
  'absolutepath',
  'apikey',
  'authorization',
  'base64',
  'blob',
  'buffer',
  'bytes',
  'cookie',
  'credential',
  'credentials',
  'cwd',
  'data',
  'externalsessionid',
  'filepath',
  'lease',
  'leaseid',
  'localpath',
  'password',
  'path',
  'pathname',
  'rawdata',
  'runid',
  'secret',
  'secrets',
  'sourcerunid',
  'token',
  'workingdirectory',
]);

/**
 * Compound metadata keys must not bypass the exact-key denylist by changing
 * case, separators, or adding a prefix/suffix. These markers intentionally
 * exclude broad words such as "data" and "key" so safe schema fields such as
 * metadata and sourceIdempotencyDigest remain portable.
 */
const FORBIDDEN_STRUCTURAL_KEY_MARKERS = [
  'absolutepath',
  'accesskey',
  'apikey',
  'apisecret',
  'authorization',
  'authheader',
  'base64',
  'bearertoken',
  'blob',
  'buffer',
  'bytes',
  'cookie',
  'credential',
  'cwd',
  'externalsessionid',
  'filepath',
  'leaseid',
  'localpath',
  'password',
  'path',
  'privatekey',
  'rawdata',
  'runid',
  'secret',
  'signingkey',
  'sourcerunid',
  'token',
  'workingdirectory',
] as const;

const ARTIFACT_BLOCK = /```(?:chart|spreadsheet|mermaid|html|generative_ui|neo_ui|question-form)\s*\n[\s\S]*?```/giu;

function fail(code: PortableConversationHistoryErrorCode, message: string): never {
  throw new PortableConversationHistoryError(code, message);
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

function isForbiddenStructuralKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return FORBIDDEN_STRUCTURAL_KEYS.has(normalized)
    || FORBIDDEN_STRUCTURAL_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

function pick(row: SourceRow, camel: string, snake: string): unknown {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_HISTORY', `${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) fail('INVALID_HISTORY', `${label} must be finite`);
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('ORDER_INVALID', `${label} must be a non-negative safe integer`);
  }
  return number;
}

function parseJsonValue(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return deepPortableClone(value);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    fail(
      'INVALID_HISTORY',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_HISTORY', `${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  const parsed = parseJsonValue(value, label);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    fail('INVALID_HISTORY', `${label} must be a string array`);
  }
  return parsed as string[];
}

function numberArray(value: unknown, label: string): number[] {
  const parsed = parseJsonValue(value, label);
  if (!Array.isArray(parsed)) fail('INVALID_HISTORY', `${label} must be an integer array`);
  return parsed.map((item, index) => nonNegativeInteger(item, `${label}[${index}]`));
}

function redactSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, '[REDACTED_SECRET]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[REDACTED_SECRET]')
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/giu,
      '$1=[REDACTED]',
    );
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || isForbiddenStructuralKey(key)) continue;
    result[key] = sanitizeUnknown(item);
  }
  return result;
}

function normalizeDigest(value: unknown): string {
  if (typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(value)) {
    return value.startsWith('sha256:') ? value.toLowerCase() : `sha256:${value.toLowerCase()}`;
  }
  return portabilityDigest(value ?? null);
}

function sanitizeAttachment(value: unknown): PortableConversationAttachmentProvenance {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const id = typeof source.id === 'string' ? source.id : canonicalJson(source);
  const contentMaterial = source.contentDigest
    ?? source.payloadDigest
    ?? source.bytes
    ?? source.buffer
    ?? source.base64
    ?? source.data
    ?? {
      id,
      type: source.type,
      name: source.name,
      size: source.size,
      mimeType: source.mimeType,
    };
  const result: PortableConversationAttachmentProvenance = {
    idDigest: portabilityDigest(id),
    contentDigest: normalizeDigest(contentMaterial),
  };
  for (const key of ['type', 'category', 'name', 'mimeType', 'language'] as const) {
    if (typeof source[key] === 'string') result[key] = redactSecretText(source[key] as string);
  }
  for (const key of ['size', 'pageCount', 'sheetCount', 'rowCount'] as const) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
      result[key] = source[key] as number;
    }
  }
  return result;
}

function sanitizeArtifact(value: unknown): PortableConversationArtifactProvenance {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const id = typeof source.id === 'string' ? source.id : canonicalJson(source);
  const result: PortableConversationArtifactProvenance = {
    idDigest: portabilityDigest(id),
    contentDigest: normalizeDigest(
      source.contentDigest
      ?? source.payloadDigest
      ?? source.content
      ?? source.data
      ?? { id, type: source.type, title: source.title, version: source.version },
    ),
  };
  if (typeof source.type === 'string') result.type = redactSecretText(source.type);
  if (typeof source.title === 'string') result.title = redactSecretText(source.title);
  if (typeof source.version === 'number' && Number.isFinite(source.version)) {
    result.version = source.version;
  }
  if (typeof source.parentId === 'string') {
    result.parentIdDigest = portabilityDigest(source.parentId);
  }
  return result;
}

function sanitizeMessage(
  value: unknown,
  sourceMessageId: string,
  createdAt: number,
): PortableConversationEntry['message'] {
  const source = recordValue(value, `message ${sourceMessageId}`);
  const role = source.role;
  if (!['user', 'assistant', 'system', 'tool'].includes(String(role))) {
    fail('INVALID_HISTORY', `message ${sourceMessageId} has an invalid role`);
  }
  const content = typeof source.content === 'string'
    ? redactSecretText(source.content).replace(
      ARTIFACT_BLOCK,
      '[只读 Artifact provenance：payload omitted]',
    )
    : '';
  const timestamp = typeof source.timestamp === 'number' && Number.isFinite(source.timestamp)
    ? source.timestamp
    : createdAt;
  const message: Record<string, unknown> = {
    id: sourceMessageId,
    role,
    content,
    timestamp,
  };
  for (const [key, item] of Object.entries(source)) {
    if (
      ['id', 'sessionId', 'session_id', 'role', 'content', 'timestamp', 'attachments', 'artifacts']
        .includes(key)
      || ['visibility', 'hiddenByRewindId', 'hidden_by_rewind_id', 'hiddenAt', 'hidden_at']
        .includes(key)
      || isForbiddenStructuralKey(key)
      || item === undefined
    ) {
      continue;
    }
    message[key] = sanitizeUnknown(item);
  }
  const attachments = parseOptionalArray(source.attachments);
  if (attachments.length > 0) message.attachments = attachments.map(sanitizeAttachment);
  const artifacts = parseOptionalArray(source.artifacts);
  if (artifacts.length > 0) message.artifacts = artifacts.map(sanitizeArtifact);
  return message as PortableConversationEntry['message'];
}

function parseOptionalArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  const parsed = parseJsonValue(value, 'portable array');
  return Array.isArray(parsed) ? parsed : [];
}

function withDigest<T extends Record<string, unknown>>(
  value: T,
): T & { payloadDigest: string } {
  return { ...value, payloadDigest: portabilityDigest(value) };
}

function normalizeBranch(
  row: SourceRow,
  boundary: Pick<ConversationHistorySourceRows, 'ownerUserId' | 'projectId'>,
): PortableConversationBranch {
  const id = requiredString(row.id, 'branch.id');
  const ownerUserId = nullableString(pick(row, 'ownerUserId', 'owner_user_id'));
  const projectId = nullableString(pick(row, 'projectId', 'project_id'));
  if (ownerUserId !== boundary.ownerUserId || projectId !== boundary.projectId) {
    fail('BOUNDARY_MISMATCH', `branch ${id} crosses the owner or project boundary`);
  }
  return withDigest({
    id,
    sessionId: requiredString(pick(row, 'sessionId', 'session_id'), `branch ${id}.sessionId`),
    rootBranchId: requiredString(
      pick(row, 'rootBranchId', 'root_branch_id'),
      `branch ${id}.rootBranchId`,
    ),
    parentBranchId: nullableString(pick(row, 'parentBranchId', 'parent_branch_id')),
    forkId: nullableString(pick(row, 'forkId', 'fork_id')),
    anchorEntryId: nullableString(pick(row, 'anchorEntryId', 'anchor_entry_id')),
    createdAt: finiteNumber(pick(row, 'createdAt', 'created_at'), `branch ${id}.createdAt`),
  });
}

function orderBranches(branches: PortableConversationBranch[]): PortableConversationBranch[] {
  const byId = uniqueBy(branches, (branch) => branch.id, 'branch');
  uniqueBy(branches, (branch) => branch.sessionId, 'branch session');
  for (const branch of branches) {
    if (!byId.has(branch.rootBranchId)) {
      fail('REFERENCE_NOT_CLOSED', `branch ${branch.id} references missing root ${branch.rootBranchId}`);
    }
    if (branch.parentBranchId && !byId.has(branch.parentBranchId)) {
      fail('REFERENCE_NOT_CLOSED', `branch ${branch.id} references missing parent ${branch.parentBranchId}`);
    }
    const root = byId.get(branch.rootBranchId);
    if (root?.parentBranchId !== null || root?.rootBranchId !== root.id) {
      fail('INVALID_HISTORY', `branch ${branch.id} has an invalid root lineage`);
    }
  }
  const pending = new Map(byId);
  const ordered: PortableConversationBranch[] = [];
  while (pending.size > 0) {
    const available = [...pending.values()]
      .filter((branch) => !branch.parentBranchId || !pending.has(branch.parentBranchId))
      .sort((left, right) => (
        left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
      ));
    if (available.length === 0) fail('ORDER_INVALID', 'conversation branch lineage contains a cycle');
    for (const branch of available) {
      ordered.push(branch);
      pending.delete(branch.id);
    }
  }
  return ordered;
}

function normalizeEntry(
  row: SourceRow,
  boundary: Pick<ConversationHistorySourceRows, 'ownerUserId' | 'projectId'>,
): PortableConversationEntry {
  const id = requiredString(row.id, 'entry.id');
  const ownerUserId = nullableString(pick(row, 'ownerUserId', 'owner_user_id'));
  const projectId = nullableString(pick(row, 'projectId', 'project_id'));
  if (ownerUserId !== boundary.ownerUserId || projectId !== boundary.projectId) {
    fail('BOUNDARY_MISMATCH', `entry ${id} crosses the owner or project boundary`);
  }
  const sourceSessionId = requiredString(
    pick(row, 'sourceSessionId', 'source_session_id'),
    `entry ${id}.sourceSessionId`,
  );
  const sourceMessageId = requiredString(
    pick(row, 'sourceMessageId', 'source_message_id'),
    `entry ${id}.sourceMessageId`,
  );
  const createdAt = finiteNumber(pick(row, 'createdAt', 'created_at'), `entry ${id}.createdAt`);
  const messageValue = row.message !== undefined ? row.message : pick(row, 'messageJson', 'message_json');
  const provenanceValue = row.provenance !== undefined
    ? row.provenance
    : pick(row, 'provenanceJson', 'provenance_json');
  const provenance = provenanceValue === undefined || provenanceValue === null
    ? {}
    : sanitizeUnknown(recordValue(provenanceValue, `entry ${id}.provenance`));
  return withDigest({
    id,
    sourceSessionId,
    sourceMessageId,
    sourcePayloadDigest: normalizeDigest(pick(row, 'sourcePayloadDigest', 'payload_digest')),
    message: sanitizeMessage(messageValue, sourceMessageId, createdAt),
    provenance: provenance as Record<string, unknown>,
    createdAt,
  });
}

function normalizeReference(row: SourceRow): PortableConversationReference {
  const branchId = requiredString(pick(row, 'branchId', 'branch_id'), 'reference.branchId');
  const ordinal = nonNegativeInteger(row.ordinal, `reference ${branchId}.ordinal`);
  const aliasKind = requiredString(
    pick(row, 'aliasKind', 'alias_kind'),
    `reference ${branchId}:${ordinal}.aliasKind`,
  ) as ConversationReplayMessage['aliasKind'];
  if (!ALIAS_KINDS.has(aliasKind)) {
    fail('INVALID_HISTORY', `reference ${branchId}:${ordinal} has alias kind ${aliasKind}`);
  }
  return withDigest({
    branchId,
    ordinal,
    entryId: requiredString(pick(row, 'entryId', 'entry_id'), `reference ${branchId}:${ordinal}.entryId`),
    projectedSessionId: requiredString(
      pick(row, 'projectedSessionId', 'projected_session_id'),
      `reference ${branchId}:${ordinal}.projectedSessionId`,
    ),
    projectedMessageId: requiredString(
      pick(row, 'projectedMessageId', 'projected_message_id'),
      `reference ${branchId}:${ordinal}.projectedMessageId`,
    ),
    canonicalSourceSessionId: requiredString(
      pick(row, 'canonicalSourceSessionId', 'canonical_source_session_id'),
      `reference ${branchId}:${ordinal}.canonicalSourceSessionId`,
    ),
    canonicalSourceMessageId: requiredString(
      pick(row, 'canonicalSourceMessageId', 'canonical_source_message_id'),
      `reference ${branchId}:${ordinal}.canonicalSourceMessageId`,
    ),
    aliasKind,
    createdAt: finiteNumber(
      pick(row, 'createdAt', 'created_at'),
      `reference ${branchId}:${ordinal}.createdAt`,
    ),
  });
}

function normalizeEvent(row: SourceRow): PortableConversationEvent {
  const id = requiredString(row.id, 'event.id');
  const branchId = requiredString(pick(row, 'branchId', 'branch_id'), `event ${id}.branchId`);
  const sequence = nonNegativeInteger(row.sequence, `event ${id}.sequence`);
  if (sequence === 0) fail('ORDER_INVALID', `event ${id}.sequence must start at one`);
  const eventType = requiredString(
    pick(row, 'eventType', 'event_type'),
    `event ${id}.eventType`,
  ) as ConversationBranchEventType;
  if (!SUPPORTED_EVENTS.has(eventType)) {
    fail('UNSUPPORTED_EVENT', `event ${id} has unsupported type ${eventType}`);
  }
  const rawPayload = recordValue(
    row.payload !== undefined ? row.payload : pick(row, 'payloadJson', 'payload_json'),
    `event ${id}.payload`,
  );
  const payload = sanitizeUnknown(rawPayload) as Record<string, unknown>;
  if (eventType === 'evaluation_attribution') {
    const runId = rawPayload.runId ?? rawPayload.run_id;
    if (typeof runId === 'string' && runId.length > 0) {
      payload.runProvenanceDigest = portabilityDigest(runId);
    }
  }
  return withDigest({
    id,
    branchId,
    sequence,
    eventType,
    sourceIdempotencyDigest: portabilityDigest(
      pick(row, 'idempotencyKey', 'idempotency_key') ?? id,
    ),
    payload,
    createdAt: finiteNumber(pick(row, 'createdAt', 'created_at'), `event ${id}.createdAt`),
  });
}

function orderEvents(
  events: PortableConversationEvent[],
  branchOrder: ReadonlyMap<string, number>,
): PortableConversationEvent[] {
  uniqueBy(events, (event) => event.id, 'event');
  const streams = new Map<string, PortableConversationEvent[]>();
  for (const event of events) {
    if (!branchOrder.has(event.branchId)) {
      fail('REFERENCE_NOT_CLOSED', `event ${event.id} references missing branch ${event.branchId}`);
    }
    const stream = streams.get(event.branchId) ?? [];
    stream.push(event);
    streams.set(event.branchId, stream);
  }
  for (const [branchId, stream] of streams) {
    stream.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    stream.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        fail('ORDER_INVALID', `branch ${branchId} event sequence has a gap at ${event.sequence}`);
      }
    });
  }
  const indexes = new Map([...streams.keys()].map((branchId) => [branchId, 0]));
  const ordered: PortableConversationEvent[] = [];
  while (ordered.length < events.length) {
    const available = [...streams.entries()].flatMap(([branchId, stream]) => {
      const index = indexes.get(branchId) ?? 0;
      const item = stream[index];
      return item ? [item] : [];
    }).sort((left, right) => (
      left.createdAt - right.createdAt
      || (branchOrder.get(left.branchId) ?? 0) - (branchOrder.get(right.branchId) ?? 0)
      || left.sequence - right.sequence
      || left.id.localeCompare(right.id)
    ));
    const next = available[0];
    if (!next) fail('ORDER_INVALID', 'event merge could not make progress');
    ordered.push(next);
    indexes.set(next.branchId, (indexes.get(next.branchId) ?? 0) + 1);
  }
  return ordered;
}

function normalizeEvaluation(
  row: SourceRow,
  eventsById: ReadonlyMap<string, PortableConversationEvent>,
): PortableConversationEvaluationAttribution {
  const eventId = requiredString(pick(row, 'eventId', 'event_id'), 'evaluation.eventId');
  const event = eventsById.get(eventId);
  const branchId = requiredString(
    pick(row, 'branchId', 'branch_id') ?? event?.branchId,
    `evaluation ${eventId}.branchId`,
  );
  const evaluationId = requiredString(
    pick(row, 'evaluationId', 'evaluation_id'),
    `evaluation ${eventId}.evaluationId`,
  );
  const runId = pick(row, 'runId', 'run_id');
  return withDigest({
    eventId,
    branchId,
    sequence: event?.sequence ?? nonNegativeInteger(
      pick(row, 'sequence', 'sequence'),
      `evaluation ${eventId}.sequence`,
    ),
    evaluationId,
    runProvenanceDigest: typeof runId === 'string' && runId.length > 0
      ? portabilityDigest(runId)
      : null,
    metric: requiredString(row.metric, `evaluation ${eventId}.metric`),
    value: finiteNumber(row.value, `evaluation ${eventId}.value`),
    entryIds: stringArray(
      pick(row, 'entryIds', 'entry_ids'),
      `evaluation ${eventId}.entryIds`,
    ),
    createdAt: finiteNumber(
      pick(row, 'createdAt', 'created_at') ?? event?.createdAt,
      `evaluation ${eventId}.createdAt`,
    ),
  });
}

function evaluationFromEvent(
  event: PortableConversationEvent,
): PortableConversationEvaluationAttribution {
  const payload = event.payload;
  return withDigest({
    eventId: event.id,
    branchId: event.branchId,
    sequence: event.sequence,
    evaluationId: requiredString(payload.evaluationId, `evaluation ${event.id}.evaluationId`),
    runProvenanceDigest: typeof payload.runProvenanceDigest === 'string'
      ? payload.runProvenanceDigest
      : null,
    metric: requiredString(payload.metric, `evaluation ${event.id}.metric`),
    value: finiteNumber(payload.value, `evaluation ${event.id}.value`),
    entryIds: stringArray(payload.entryIds, `evaluation ${event.id}.entryIds`),
    createdAt: event.createdAt,
  });
}

function uniqueBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) fail('INVALID_HISTORY', `${label} ${id} is duplicated`);
    result.set(id, item);
  }
  return result;
}

function unsigned<T extends { payloadDigest: string }>(value: T): Omit<T, 'payloadDigest'> {
  const { payloadDigest: _payloadDigest, ...rest } = value;
  return rest;
}

function assertDigest<T extends { payloadDigest: string }>(value: T, label: string): void {
  if (value.payloadDigest !== portabilityDigest(unsigned(value))) {
    fail('DIGEST_MISMATCH', `${label} payload digest does not match`);
  }
}

function assertStructurallyPrivate(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStructurallyPrivate(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenStructuralKey(key)) {
      if (normalizeKey(key) === 'runid' && item === null) continue;
      fail('PRIVACY_VIOLATION', `${path}.${key} is runtime, path, byte, or secret material`);
    }
    assertStructurallyPrivate(item, `${path}.${key}`);
  }
}

/** @internal Shared with the pure import planner without duplicating policy. */
export const conversationHistoryCodecInternals = {
  fail,
  requiredString,
  nonNegativeInteger,
  stringArray,
  numberArray,
  assertStructurallyPrivate,
};

export function buildPortableConversationHistory(
  input: ConversationHistorySourceRows,
): PortableConversationHistoryV1 {
  if (!Object.prototype.hasOwnProperty.call(input, 'ownerUserId')
      || !Object.prototype.hasOwnProperty.call(input, 'projectId')) {
    fail('BOUNDARY_MISMATCH', 'exact owner and project boundaries are required');
  }
  const branches = orderBranches(input.branches.map((row) => normalizeBranch(row, input)));
  const branchOrder = new Map(branches.map((branch, index) => [branch.id, index]));
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const entries = input.entries.map((row) => normalizeEntry(row, input))
    .sort((left, right) => (
      left.createdAt - right.createdAt
      || left.sourceSessionId.localeCompare(right.sourceSessionId)
      || left.sourceMessageId.localeCompare(right.sourceMessageId)
      || left.id.localeCompare(right.id)
    ));
  const entryById = uniqueBy(entries, (entry) => entry.id, 'entry');
  const references = input.references.map(normalizeReference)
    .sort((left, right) => (
      (branchOrder.get(left.branchId) ?? Number.MAX_SAFE_INTEGER)
      - (branchOrder.get(right.branchId) ?? Number.MAX_SAFE_INTEGER)
      || left.ordinal - right.ordinal
      || left.entryId.localeCompare(right.entryId)
    ));
  const referenceKeys = new Set<string>();
  const referenceStreams = new Map<string, PortableConversationReference[]>();
  for (const reference of references) {
    const branch = branchById.get(reference.branchId);
    if (!branch || !entryById.has(reference.entryId)) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `reference ${reference.branchId}:${reference.ordinal} is outside the portable history`,
      );
    }
    if (reference.projectedSessionId !== branch.sessionId) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `reference ${reference.branchId}:${reference.ordinal} projects another session`,
      );
    }
    const key = `${reference.branchId}:${reference.ordinal}`;
    if (referenceKeys.has(key)) fail('ORDER_INVALID', `reference ${key} is duplicated`);
    referenceKeys.add(key);
    const stream = referenceStreams.get(reference.branchId) ?? [];
    stream.push(reference);
    referenceStreams.set(reference.branchId, stream);
  }
  for (const [branchId, stream] of referenceStreams) {
    stream.forEach((reference, index) => {
      if (reference.ordinal !== index) {
        fail('ORDER_INVALID', `branch ${branchId} reference ordinal has a gap at ${reference.ordinal}`);
      }
    });
  }
  const events = orderEvents(input.events.map(normalizeEvent), branchOrder);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const evaluationsByEvent = new Map<string, PortableConversationEvaluationAttribution>();
  for (const event of events) {
    if (event.eventType !== 'evaluation_attribution') continue;
    evaluationsByEvent.set(event.id, evaluationFromEvent(event));
  }
  for (const row of input.evaluationAttributions ?? []) {
    const evaluation = normalizeEvaluation(row, eventsById);
    const existing = evaluationsByEvent.get(evaluation.eventId);
    if (
      existing
      && canonicalJson(unsigned(existing)) !== canonicalJson(unsigned(evaluation))
    ) {
      fail(
        'INVALID_HISTORY',
        `evaluation ${evaluation.eventId} conflicts with its immutable event`,
      );
    }
    evaluationsByEvent.set(evaluation.eventId, existing ?? evaluation);
  }
  const eventOrder = new Map(events.map((event, index) => [event.id, index]));
  const evaluationAttributions = [...evaluationsByEvent.values()]
    .sort((left, right) => (
      (eventOrder.get(left.eventId) ?? Number.MAX_SAFE_INTEGER)
      - (eventOrder.get(right.eventId) ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.eventId.localeCompare(right.eventId)
    ));
  for (const evaluation of evaluationAttributions) {
    if (!branchById.has(evaluation.branchId)) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `evaluation ${evaluation.eventId} references missing branch ${evaluation.branchId}`,
      );
    }
    evaluation.entryIds.forEach((entryId) => {
      if (!entryById.has(entryId)) {
        fail(
          'REFERENCE_NOT_CLOSED',
          `evaluation ${evaluation.eventId} references missing entry ${entryId}`,
        );
      }
    });
  }
  const history = rehashPortableConversationHistory({
    schema: PORTABLE_CONVERSATION_HISTORY_SCHEMA,
    version: PORTABLE_CONVERSATION_HISTORY_VERSION,
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    branches,
    entries,
    references,
    events,
    evaluationAttributions,
  });
  validatePortableConversationHistory(history);
  return history;
}

export function rehashPortableConversationHistory(
  input:
    | Omit<PortableConversationHistoryV1, 'payloadDigest'>
    | PortableConversationHistoryV1,
): PortableConversationHistoryV1 {
  const unsignedHistory = 'payloadDigest' in input ? unsigned(input) : input;
  return {
    ...deepPortableClone(unsignedHistory),
    payloadDigest: portabilityDigest(unsignedHistory),
  };
}

export function validatePortableConversationHistory(
  history: PortableConversationHistoryV1,
): void {
  if (
    history.schema !== PORTABLE_CONVERSATION_HISTORY_SCHEMA
    || history.version !== PORTABLE_CONVERSATION_HISTORY_VERSION
  ) {
    fail('INVALID_HISTORY', 'unsupported portable conversation history schema');
  }
  if (
    !Array.isArray(history.branches)
    || !Array.isArray(history.entries)
    || !Array.isArray(history.references)
    || !Array.isArray(history.events)
    || !Array.isArray(history.evaluationAttributions)
  ) {
    fail('INVALID_HISTORY', 'portable conversation history collections are required');
  }
  assertDigest(history, 'history');
  history.branches.forEach((item, index) => assertDigest(item, `branch[${index}]`));
  history.entries.forEach((item, index) => assertDigest(item, `entry[${index}]`));
  history.references.forEach((item, index) => assertDigest(item, `reference[${index}]`));
  history.events.forEach((item, index) => {
    assertDigest(item, `event[${index}]`);
    if (!SUPPORTED_EVENTS.has(item.eventType)) {
      fail('UNSUPPORTED_EVENT', `event ${item.id} has unsupported type ${item.eventType}`);
    }
  });
  history.evaluationAttributions.forEach(
    (item, index) => assertDigest(item, `evaluation[${index}]`),
  );
  assertStructurallyPrivate(history);
  const orderedBranches = orderBranches([...history.branches]);
  if (orderedBranches.some((branch, index) => branch.id !== history.branches[index]?.id)) {
    fail('ORDER_INVALID', 'portable branches are not canonically ordered');
  }
  const branchOrder = new Map(history.branches.map((branch, index) => [branch.id, index]));
  const branchById = uniqueBy(history.branches, (branch) => branch.id, 'branch');
  uniqueBy(history.entries, (entry) => entry.id, 'entry');
  const expectedEntries = [...history.entries].sort((left, right) => (
    left.createdAt - right.createdAt
    || left.sourceSessionId.localeCompare(right.sourceSessionId)
    || left.sourceMessageId.localeCompare(right.sourceMessageId)
    || left.id.localeCompare(right.id)
  ));
  if (expectedEntries.some((entry, index) => entry.id !== history.entries[index]?.id)) {
    fail('ORDER_INVALID', 'portable entries are not canonically ordered');
  }
  const entryIds = new Set(history.entries.map((entry) => entry.id));
  const referenceStreams = new Map<string, PortableConversationReference[]>();
  for (const reference of history.references) {
    const branch = branchById.get(reference.branchId);
    if (!branch || !entryIds.has(reference.entryId) || reference.projectedSessionId !== branch.sessionId) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `reference ${reference.branchId}:${reference.ordinal} is outside the portable history`,
      );
    }
    const stream = referenceStreams.get(reference.branchId) ?? [];
    stream.push(reference);
    referenceStreams.set(reference.branchId, stream);
  }
  for (const [branchId, stream] of referenceStreams) {
    stream.forEach((reference, index) => {
      if (reference.ordinal !== index) {
        fail('ORDER_INVALID', `branch ${branchId} reference ordinal has a gap`);
      }
    });
  }
  const expectedReferences = [...history.references].sort((left, right) => (
    (branchOrder.get(left.branchId) ?? Number.MAX_SAFE_INTEGER)
    - (branchOrder.get(right.branchId) ?? Number.MAX_SAFE_INTEGER)
    || left.ordinal - right.ordinal
    || left.entryId.localeCompare(right.entryId)
  ));
  if (
    expectedReferences.some((reference, index) => (
      reference.branchId !== history.references[index]?.branchId
      || reference.ordinal !== history.references[index]?.ordinal
    ))
  ) {
    fail('ORDER_INVALID', 'portable references are not canonically ordered');
  }
  const orderedEvents = orderEvents([...history.events], branchOrder);
  if (orderedEvents.some((event, index) => event.id !== history.events[index]?.id)) {
    fail('ORDER_INVALID', 'portable events are not canonically ordered');
  }
  const eventOrder = new Map(history.events.map((event, index) => [event.id, index]));
  const expectedEvaluations = [...history.evaluationAttributions].sort((left, right) => (
    (eventOrder.get(left.eventId) ?? Number.MAX_SAFE_INTEGER)
    - (eventOrder.get(right.eventId) ?? Number.MAX_SAFE_INTEGER)
    || left.createdAt - right.createdAt
    || left.eventId.localeCompare(right.eventId)
  ));
  if (
    expectedEvaluations.some((evaluation, index) => (
      evaluation.eventId !== history.evaluationAttributions[index]?.eventId
    ))
  ) {
    fail('ORDER_INVALID', 'portable evaluation attributions are not canonically ordered');
  }
}

export function encodePortableConversationHistory(
  history: PortableConversationHistoryV1,
): string {
  validatePortableConversationHistory(history);
  return canonicalJson(history);
}

export function decodePortableConversationHistory(
  serialized: string | unknown,
): PortableConversationHistoryV1 {
  const parsed = typeof serialized === 'string'
    ? parseJsonValue(serialized, 'portable conversation history')
    : deepPortableClone(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_HISTORY', 'portable conversation history must be an object');
  }
  const history = parsed as PortableConversationHistoryV1;
  validatePortableConversationHistory(history);
  return deepPortableClone(history);
}

export { planPortableConversationHistoryImport } from './conversationHistoryImportPlan';
