import type { MessageAttachment } from '../../../../shared/contract/message';
import type {
  BuildSessionExportEnvelopeV2Input,
  ForkLineageDraftV1,
  ForkLineageEnvelopeV1,
  ForkLineageMessageMappingV1,
  ForkLineageNodeV1,
  ForkLineageValidationScope,
  LegacyForkClaimStripResult,
  PortableAgentEngineV2,
  PortableArtifactProvenanceV2,
  PortableAttachmentProvenanceV2,
  PortableMessageV2,
  PortableModelConfigV2,
  PortableSessionV2,
  SessionExportDecodeScope,
  SessionExportEnvelopeV2,
  SessionExportSourceV2,
} from '../../../../shared/contract/sessionForkPortability';
import {
  FORK_LINEAGE_ENVELOPE_SCHEMA,
  FORK_LINEAGE_ENVELOPE_VERSION,
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  SESSION_EXPORT_ENVELOPE_SCHEMA,
  SESSION_EXPORT_ENVELOPE_VERSION,
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import { canonicalJson, deepPortableClone, portabilityDigest, withoutDigest } from './canonical';
import { validatePortableConversationHistory } from './conversationHistory';
import {
  sanitizePortableSessionWorkspaceV2,
  validatePortableSessionWorkspaceV2,
} from './portableWorkspaceEvidence';

const FORBIDDEN_RUNTIME_KEYS = new Set([
  'absoluteWorktreePath', 'apiKey', 'approvalQueue', 'approvalRequests',
  'baseUrl', 'cwd', 'durableWaitingInput', 'executablePermission',
  'externalSessionId', 'lease', 'leaseId', 'logPath',
  'pendingApproval', 'pendingApprovals', 'permissionGrant', 'queuedInput',
  'queuedInputs', 'runId', 'sourceRunId', 'streamSnapshot',
  'taskLease', 'todo', 'todos', 'workingDirectory',
]);

function fail(code: ConstructorParameters<typeof SessionForkPortabilityError>[0], message: string): never {
  throw new SessionForkPortabilityError(code, message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ENVELOPE', `${label} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_ENVELOPE', `${label} must be a non-empty string`);
  }
}

function assertInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('ORDINAL_INVALID', `${label} must be a non-negative safe integer`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail('INVALID_ENVELOPE', `${label}.${key} is not part of the portable schema`);
    }
  }
}

function assertPortableDigest(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(value)
  ) {
    fail('DIGEST_MISMATCH', `${label} must be a SHA-256 digest`);
  }
}

function parseJson(value: string | unknown, label: string): unknown {
  if (typeof value !== 'string') return deepPortableClone(value);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    fail('INVALID_ENVELOPE', `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertNoRuntimeIdentity(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRuntimeIdentity(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RUNTIME_KEYS.has(key)) {
      const code = key === 'absoluteWorktreePath' || key === 'cwd' || key === 'workingDirectory'
        ? 'ABSOLUTE_WORKTREE_FORBIDDEN'
        : 'RUNTIME_IDENTITY_FORBIDDEN';
      fail(code, `${path}.${key} is runtime-only`);
    }
    assertNoRuntimeIdentity(item, `${path}.${key}`);
  }
}

function sanitizeModelConfig(source: SessionExportSourceV2['session']['modelConfig']): PortableModelConfigV2 {
  const config: PortableModelConfigV2 = {
    provider: source.provider,
    model: source.model,
  };
  if (source.protocol !== undefined) config.protocol = source.protocol;
  if (source.temperature !== undefined) config.temperature = source.temperature;
  if (source.maxTokens !== undefined) config.maxTokens = source.maxTokens;
  if (source.capabilities !== undefined) config.capabilities = [...source.capabilities];
  if (source.computerUse !== undefined) config.computerUse = source.computerUse;
  if (source.promptCaching !== undefined) config.promptCaching = { ...source.promptCaching };
  if (source.thinkingBudget !== undefined) config.thinkingBudget = source.thinkingBudget;
  if (source.reasoningEffort !== undefined) config.reasoningEffort = source.reasoningEffort;
  if (source.adaptive !== undefined) config.adaptive = source.adaptive;
  return config;
}

function sanitizeEngine(source: SessionExportSourceV2['session']['engine']): PortableAgentEngineV2 | undefined {
  if (!source) return undefined;
  const engine: PortableAgentEngineV2 = { kind: source.kind };
  if (source.model !== undefined) engine.model = source.model;
  if (source.permissionProfile !== undefined) engine.permissionProfile = source.permissionProfile;
  if (source.origin !== undefined) engine.origin = source.origin;
  return engine;
}

function sanitizeAttachment(source: MessageAttachment): PortableAttachmentProvenanceV2 {
  const existingDigest = (source as MessageAttachment & { contentDigest?: unknown }).contentDigest;
  const attachment: PortableAttachmentProvenanceV2 = {
    id: source.id,
    type: source.type,
    category: source.category,
    name: source.name,
    size: source.size,
    mimeType: source.mimeType,
    contentDigest: typeof existingDigest === 'string'
      && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(existingDigest)
      ? existingDigest.toLowerCase().replace(/^(?!sha256:)/u, 'sha256:')
      : portabilityDigest(source),
  };
  if (source.pageCount !== undefined) attachment.pageCount = source.pageCount;
  if (source.sheetCount !== undefined) attachment.sheetCount = source.sheetCount;
  if (source.rowCount !== undefined) attachment.rowCount = source.rowCount;
  if (source.language !== undefined) attachment.language = source.language;
  return attachment;
}

function sanitizeArtifacts(source: SessionExportSourceV2['messages'][number]['artifacts']): PortableArtifactProvenanceV2[] | undefined {
  if (!source?.length) return undefined;
  return source.map((artifact) => {
    const existingDigest = (artifact as typeof artifact & { contentDigest?: unknown })
      .contentDigest;
    return {
      id: artifact.id,
      type: artifact.type,
      ...(artifact.title !== undefined ? { title: artifact.title } : {}),
      version: artifact.version,
      ...(artifact.parentId !== undefined ? { parentId: artifact.parentId } : {}),
      contentDigest: typeof existingDigest === 'string'
        && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(existingDigest)
        ? existingDigest.toLowerCase().replace(/^(?!sha256:)/u, 'sha256:')
        : portabilityDigest(artifact.content),
    };
  });
}

function rehashMessage(message: Omit<PortableMessageV2, 'payloadDigest'> | PortableMessageV2): PortableMessageV2 {
  const unsigned = 'payloadDigest' in message ? withoutDigest(message) : message;
  return { ...unsigned, payloadDigest: portabilityDigest(unsigned) };
}

function rehashSession(session: Omit<PortableSessionV2, 'payloadDigest'> | PortableSessionV2): PortableSessionV2 {
  const unsigned = 'payloadDigest' in session ? withoutDigest(session) : session;
  return { ...unsigned, payloadDigest: portabilityDigest(unsigned) };
}

function sanitizeSession(
  source: SessionExportSourceV2,
  ownerScopeId: string,
  projectId: string,
): PortableSessionV2 {
  const raw = source.session;
  if (raw.userId !== undefined && raw.userId !== null && raw.userId !== ownerScopeId) {
    fail('OWNER_SCOPE_MISMATCH', `session ${raw.id} belongs to ${raw.userId}`);
  }
  if (raw.projectId !== projectId) {
    fail('PROJECT_SCOPE_MISMATCH', `session ${raw.id} belongs to ${raw.projectId ?? 'no project'}`);
  }
  const portable: Omit<PortableSessionV2, 'payloadDigest'> = {
    id: raw.id,
    ownerScopeId,
    projectId,
    title: raw.title,
    modelConfig: sanitizeModelConfig(raw.modelConfig),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (raw.type !== undefined) portable.type = raw.type;
  if (raw.origin !== undefined) {
    portable.origin = {
      kind: raw.origin.kind,
      ...(raw.origin.name !== undefined ? { name: raw.origin.name } : {}),
    };
  }
  if (raw.memoryMode !== undefined) portable.memoryMode = raw.memoryMode;
  if (raw.suppressedMemoryEntryIds !== undefined) {
    portable.suppressedMemoryEntryIds = [...raw.suppressedMemoryEntryIds];
  }
  if (raw.readOnly !== undefined) portable.readOnly = raw.readOnly;
  const engine = sanitizeEngine(raw.engine);
  if (engine) portable.engine = engine;
  const workspace = sanitizePortableSessionWorkspaceV2(source.workspace);
  if (workspace) portable.workspace = workspace;
  return rehashSession(portable);
}

function sanitizeMessages(source: SessionExportSourceV2): PortableMessageV2[] {
  return source.messages.map((raw, ordinal) => {
    const portable: Omit<PortableMessageV2, 'payloadDigest'> = {
      id: raw.id,
      sessionId: source.session.id,
      ordinal,
      role: raw.role,
      content: raw.content,
      timestamp: raw.timestamp,
    };
    if (raw.visibility !== undefined) portable.visibility = raw.visibility;
    if (raw.isMeta !== undefined) portable.isMeta = raw.isMeta;
    if (raw.source !== undefined) portable.source = raw.source;
    if (raw.subtype !== undefined) portable.subtype = raw.subtype;
    if (raw.attachments?.length) {
      portable.attachments = raw.attachments.map(sanitizeAttachment);
    }
    const artifacts = sanitizeArtifacts(raw.artifacts);
    if (artifacts) portable.artifacts = artifacts;
    return rehashMessage(portable);
  });
}

function rehashLineageNode(
  node: Omit<ForkLineageNodeV1, 'payloadDigest'> | ForkLineageNodeV1,
): ForkLineageNodeV1 {
  const unsigned = 'payloadDigest' in node ? withoutDigest(node) : node;
  return { ...unsigned, payloadDigest: portabilityDigest(unsigned) };
}

function rehashLineageMapping(
  mapping: Omit<ForkLineageMessageMappingV1, 'payloadDigest'> | ForkLineageMessageMappingV1,
): ForkLineageMessageMappingV1 {
  const unsigned = 'payloadDigest' in mapping ? withoutDigest(mapping) : mapping;
  return { ...unsigned, payloadDigest: portabilityDigest(unsigned) };
}

function sortLineageNodes(nodes: ForkLineageNodeV1[]): ForkLineageNodeV1[] {
  return [...nodes].sort((left, right) => (
    left.depth - right.depth
    || (left.parentSessionId ?? '').localeCompare(right.parentSessionId ?? '')
    || left.ordinal - right.ordinal
    || left.createdAt - right.createdAt
    || left.sessionId.localeCompare(right.sessionId)
  ));
}

function sortMappings(mappings: ForkLineageMessageMappingV1[]): ForkLineageMessageMappingV1[] {
  return [...mappings].sort((left, right) => (
    left.forkId.localeCompare(right.forkId)
    || left.ordinal - right.ordinal
    || left.childMessageId.localeCompare(right.childMessageId)
  ));
}

function rehashLineageEnvelope(
  lineage: Omit<ForkLineageEnvelopeV1, 'payloadDigest'> | ForkLineageEnvelopeV1,
): ForkLineageEnvelopeV1 {
  const unsigned = 'payloadDigest' in lineage ? withoutDigest(lineage) : lineage;
  const normalized = {
    ...unsigned,
    nodes: sortLineageNodes(unsigned.nodes.map(rehashLineageNode)),
    messageMappings: sortMappings(unsigned.messageMappings.map(rehashLineageMapping)),
  };
  return { ...normalized, payloadDigest: portabilityDigest(normalized) };
}

function lineageFromDraft(
  draft: ForkLineageDraftV1,
  ownerScopeId: string,
  projectId: string,
  rootSessionId: string,
): ForkLineageEnvelopeV1 {
  return rehashLineageEnvelope({
    schema: FORK_LINEAGE_ENVELOPE_SCHEMA,
    version: FORK_LINEAGE_ENVELOPE_VERSION,
    ownerScopeId,
    projectId,
    rootSessionId,
    createdAt: draft.createdAt,
    nodes: draft.nodes.map((node) => rehashLineageNode({
      ...node,
      ownerScopeId,
      projectId,
    })),
    messageMappings: draft.messageMappings.map(rehashLineageMapping),
  });
}

function detachedLineage(
  session: PortableSessionV2,
  messages: PortableMessageV2[],
  createdAt: number,
): ForkLineageEnvelopeV1 {
  const workspaceMode = session.workspace?.mode ?? 'shared_current';
  const anchor = messages.at(-1)?.id ?? null;
  return rehashLineageEnvelope({
    schema: FORK_LINEAGE_ENVELOPE_SCHEMA,
    version: FORK_LINEAGE_ENVELOPE_VERSION,
    ownerScopeId: session.ownerScopeId,
    projectId: session.projectId,
    rootSessionId: session.id,
    createdAt,
    nodes: [rehashLineageNode({
      forkId: null,
      sessionId: session.id,
      parentSessionId: null,
      rootSessionId: session.id,
      sourceAnchorMessageId: null,
      anchorChildMessageId: anchor,
      depth: 0,
      ordinal: 0,
      workspaceMode,
      contextDeliveryMode: 'neo_native_prefix',
      ownerScopeId: session.ownerScopeId,
      projectId: session.projectId,
      createdAt: session.createdAt,
    })],
    messageMappings: [],
  });
}

function assertDigest(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    fail('DIGEST_MISMATCH', `${label} digest does not match its canonical payload`);
  }
}

function validateLineageDigests(lineage: ForkLineageEnvelopeV1): void {
  for (const node of lineage.nodes) {
    assertDigest(node.payloadDigest, portabilityDigest(withoutDigest(node)), `lineage node ${node.sessionId}`);
  }
  for (const mapping of lineage.messageMappings) {
    assertDigest(
      mapping.payloadDigest,
      portabilityDigest(withoutDigest(mapping)),
      `message mapping ${mapping.forkId}:${mapping.ordinal}`,
    );
  }
  assertDigest(lineage.payloadDigest, portabilityDigest(withoutDigest(lineage)), 'lineage envelope');
}

function validateSiblingOrdinals(nodes: ForkLineageNodeV1[]): void {
  const groups = new Map<string, ForkLineageNodeV1[]>();
  for (const node of nodes) {
    const key = node.parentSessionId ?? '__root__';
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  for (const [parent, siblings] of groups) {
    const ordinals = siblings.map((item) => item.ordinal).sort((a, b) => a - b);
    ordinals.forEach((ordinal, index) => {
      if (ordinal !== index) {
        fail('ORDINAL_INVALID', `children of ${parent} must use contiguous ordinals from zero`);
      }
    });
  }
}

function validateMappingOrdinals(mappings: ForkLineageMessageMappingV1[]): void {
  const groups = new Map<string, ForkLineageMessageMappingV1[]>();
  for (const mapping of mappings) {
    const group = groups.get(mapping.forkId) ?? [];
    group.push(mapping);
    groups.set(mapping.forkId, group);
  }
  for (const [forkId, entries] of groups) {
    const ordinals = entries.map((item) => item.ordinal).sort((a, b) => a - b);
    ordinals.forEach((ordinal, index) => {
      if (ordinal !== index) {
        fail('ORDINAL_INVALID', `message mappings for ${forkId} must use contiguous ordinals from zero`);
      }
    });
  }
}

export function validateForkLineageEnvelopeV1(
  lineage: ForkLineageEnvelopeV1,
  scope?: ForkLineageValidationScope,
  messageSessionById?: ReadonlyMap<string, string>,
): void {
  assertObject(lineage, 'lineage');
  if (
    lineage.schema !== FORK_LINEAGE_ENVELOPE_SCHEMA
    || lineage.version !== FORK_LINEAGE_ENVELOPE_VERSION
  ) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'expected neo.fork-lineage version 1');
  }
  if (!Array.isArray(lineage.nodes) || !Array.isArray(lineage.messageMappings)) {
    fail('INVALID_ENVELOPE', 'lineage nodes and mappings must be arrays');
  }
  assertOnlyKeys(lineage as unknown as Record<string, unknown>, [
    'schema',
    'version',
    'ownerScopeId',
    'projectId',
    'rootSessionId',
    'createdAt',
    'nodes',
    'messageMappings',
    'payloadDigest',
  ], 'lineage');
  assertNonEmptyString(lineage.ownerScopeId, 'lineage.ownerScopeId');
  assertNonEmptyString(lineage.projectId, 'lineage.projectId');
  assertNonEmptyString(lineage.rootSessionId, 'lineage.rootSessionId');
  assertNoRuntimeIdentity(lineage);
  if (scope) {
    if (lineage.ownerScopeId !== scope.ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `lineage belongs to ${lineage.ownerScopeId}`);
    }
    if (lineage.projectId !== scope.projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `lineage belongs to ${lineage.projectId}`);
    }
  }

  const nodes = new Map<string, ForkLineageNodeV1>();
  const forkNodes = new Map<string, ForkLineageNodeV1>();
  for (const node of lineage.nodes) {
    assertObject(node, 'lineage node');
    assertOnlyKeys(node as unknown as Record<string, unknown>, [
      'forkId',
      'sessionId',
      'parentSessionId',
      'rootSessionId',
      'sourceAnchorMessageId',
      'anchorChildMessageId',
      'depth',
      'ordinal',
      'workspaceMode',
      'contextDeliveryMode',
      'ownerScopeId',
      'projectId',
      'createdAt',
      'payloadDigest',
    ], `lineage.nodes[${node.sessionId}]`);
    assertInteger(node.depth, `node ${node.sessionId} depth`);
    assertInteger(node.ordinal, `node ${node.sessionId} ordinal`);
    if (nodes.has(node.sessionId)) {
      fail('LINEAGE_INVALID', `duplicate lineage node ${node.sessionId}`);
    }
    if (scope && !scope.sessionIds.has(node.sessionId)) {
      fail('REFERENCE_NOT_CLOSED', `lineage node ${node.sessionId} is outside the export`);
    }
    if (node.ownerScopeId !== lineage.ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `node ${node.sessionId} owner differs from lineage`);
    }
    if (node.projectId !== lineage.projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `node ${node.sessionId} project differs from lineage`);
    }
    if (node.rootSessionId !== lineage.rootSessionId) {
      fail('LINEAGE_INVALID', `node ${node.sessionId} has another root`);
    }
    if (node.forkId !== null) {
      if (forkNodes.has(node.forkId)) {
        fail('LINEAGE_INVALID', `duplicate fork id ${node.forkId}`);
      }
      forkNodes.set(node.forkId, node);
    }
    nodes.set(node.sessionId, node);
  }
  const root = nodes.get(lineage.rootSessionId);
  if (root?.parentSessionId !== null || root?.depth !== 0 || root?.forkId !== null) {
    fail('LINEAGE_INVALID', 'root node must exist with null parent/fork and depth zero');
  }
  for (const node of lineage.nodes) {
    if (node === root) continue;
    if (!node.parentSessionId || !node.forkId) {
      fail('LINEAGE_INVALID', `child ${node.sessionId} must have parent and fork ids`);
    }
    const parent = nodes.get(node.parentSessionId);
    if (!parent) {
      fail('REFERENCE_NOT_CLOSED', `parent ${node.parentSessionId} is not in the exported subtree`);
    }
    if (node.depth !== parent.depth + 1) {
      fail('LINEAGE_INVALID', `child ${node.sessionId} depth does not follow its parent`);
    }
    if (
      scope
      && (
        !node.sourceAnchorMessageId
        || !scope.messageIds.has(node.sourceAnchorMessageId)
        || !node.anchorChildMessageId
        || !scope.messageIds.has(node.anchorChildMessageId)
      )
    ) {
      fail('REFERENCE_NOT_CLOSED', `child ${node.sessionId} anchor messages are not in the export`);
    }
    if (messageSessionById) {
      if (messageSessionById.get(node.sourceAnchorMessageId ?? '') !== node.parentSessionId) {
        fail('REFERENCE_NOT_CLOSED', `source anchor for ${node.sessionId} is not owned by its parent`);
      }
      if (messageSessionById.get(node.anchorChildMessageId ?? '') !== node.sessionId) {
        fail('REFERENCE_NOT_CLOSED', `child anchor for ${node.sessionId} is not owned by the child`);
      }
    }
  }
  validateSiblingOrdinals(lineage.nodes);
  validateMappingOrdinals(lineage.messageMappings);

  for (const mapping of lineage.messageMappings) {
    assertObject(mapping, 'lineage message mapping');
    assertOnlyKeys(mapping as unknown as Record<string, unknown>, [
      'forkId',
      'ordinal',
      'sourceSessionId',
      'childSessionId',
      'sourceMessageId',
      'childMessageId',
      'sourceTimestamp',
      'sourceOrderKey',
      'sourceRowDigest',
      'payloadDigest',
    ], `lineage.messageMappings[${mapping.forkId}:${mapping.ordinal}]`);
    assertPortableDigest(
      mapping.sourceRowDigest,
      `lineage.messageMappings[${mapping.forkId}:${mapping.ordinal}].sourceRowDigest`,
    );
    const childNode = forkNodes.get(mapping.forkId);
    if (
      childNode?.sessionId !== mapping.childSessionId
      || childNode?.parentSessionId !== mapping.sourceSessionId
    ) {
      fail('REFERENCE_NOT_CLOSED', `mapping ${mapping.forkId}:${mapping.ordinal} does not resolve to its lineage edge`);
    }
    if (
      scope
      && (
        !scope.messageIds.has(mapping.sourceMessageId)
        || !scope.messageIds.has(mapping.childMessageId)
      )
    ) {
      fail('REFERENCE_NOT_CLOSED', `mapping ${mapping.forkId}:${mapping.ordinal} references a missing message`);
    }
    if (
      messageSessionById
      && (
        messageSessionById.get(mapping.sourceMessageId) !== mapping.sourceSessionId
        || messageSessionById.get(mapping.childMessageId) !== mapping.childSessionId
      )
    ) {
      fail('REFERENCE_NOT_CLOSED', `mapping ${mapping.forkId}:${mapping.ordinal} crosses session ownership`);
    }
  }
  validateLineageDigests(lineage);
}

export function buildForkLineageEnvelopeV1(
  input: ForkLineageEnvelopeV1,
): ForkLineageEnvelopeV1 {
  const rebuilt = rehashLineageEnvelope(deepPortableClone(input));
  validateForkLineageEnvelopeV1(rebuilt);
  return rebuilt;
}

export function encodeForkLineageEnvelopeV1(lineage: ForkLineageEnvelopeV1): string {
  validateForkLineageEnvelopeV1(lineage);
  return canonicalJson(lineage);
}

export function decodeForkLineageEnvelopeV1(
  value: string | unknown,
  scope?: ForkLineageValidationScope,
): ForkLineageEnvelopeV1 {
  const parsed = parseJson(value, 'lineage envelope');
  assertObject(parsed, 'lineage envelope');
  const lineage = parsed as unknown as ForkLineageEnvelopeV1;
  validateForkLineageEnvelopeV1(lineage, scope);
  return deepPortableClone(lineage);
}

function validateMessageOrdinals(messages: PortableMessageV2[], sessionIds: ReadonlySet<string>): void {
  const grouped = new Map<string, PortableMessageV2[]>();
  const allMessageIds = new Set<string>();
  for (const message of messages) {
    assertObject(message, 'portable message');
    assertOnlyKeys(message as unknown as Record<string, unknown>, [
      'id',
      'sessionId',
      'ordinal',
      'role',
      'content',
      'timestamp',
      'visibility',
      'isMeta',
      'source',
      'subtype',
      'attachments',
      'artifacts',
      'payloadDigest',
    ], `messages[${message.id}]`);
    if (allMessageIds.has(message.id)) {
      fail('REFERENCE_NOT_CLOSED', `duplicate message id ${message.id}`);
    }
    allMessageIds.add(message.id);
    if (!sessionIds.has(message.sessionId)) {
      fail('REFERENCE_NOT_CLOSED', `message ${message.id} references missing session ${message.sessionId}`);
    }
    assertInteger(message.ordinal, `message ${message.id} ordinal`);
    const group = grouped.get(message.sessionId) ?? [];
    group.push(message);
    grouped.set(message.sessionId, group);
    for (const attachment of message.attachments ?? []) {
      assertObject(attachment, `message ${message.id} attachment`);
      const raw = attachment as unknown as Record<string, unknown>;
      assertOnlyKeys(raw, [
        'id',
        'type',
        'category',
        'name',
        'size',
        'mimeType',
        'pageCount',
        'sheetCount',
        'rowCount',
        'language',
        'contentDigest',
      ], `messages[${message.id}].attachments[${attachment.id}]`);
      assertPortableDigest(
        attachment.contentDigest,
        `messages[${message.id}].attachments[${attachment.id}].contentDigest`,
      );
    }
    for (const artifact of message.artifacts ?? []) {
      assertObject(artifact, `message ${message.id} artifact`);
      assertOnlyKeys(artifact as unknown as Record<string, unknown>, [
        'id',
        'type',
        'title',
        'version',
        'parentId',
        'contentDigest',
      ], `messages[${message.id}].artifacts[${artifact.id}]`);
      assertPortableDigest(artifact.contentDigest, `artifact ${artifact.id}.contentDigest`);
    }
  }
  for (const sessionId of sessionIds) {
    const entries = grouped.get(sessionId) ?? [];
    const ordinals = entries.map((item) => item.ordinal).sort((a, b) => a - b);
    ordinals.forEach((ordinal, index) => {
      if (ordinal !== index) {
        fail('ORDINAL_INVALID', `messages for ${sessionId} must use contiguous ordinals from zero`);
      }
    });
  }
  for (const message of messages) {
    assertDigest(
      message.payloadDigest,
      portabilityDigest(withoutDigest(message)),
      `message ${message.id}`,
    );
  }
}

export function validateSessionExportEnvelopeV2(
  envelope: SessionExportEnvelopeV2,
  expectedScope?: SessionExportDecodeScope,
): void {
  assertObject(envelope, 'session export envelope');
  if (
    envelope.schema !== SESSION_EXPORT_ENVELOPE_SCHEMA
    || envelope.version !== SESSION_EXPORT_ENVELOPE_VERSION
  ) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'expected neo.session-export version 2');
  }
  assertNonEmptyString(envelope.exportId, 'exportId');
  assertNonEmptyString(envelope.ownerScopeId, 'ownerScopeId');
  assertNonEmptyString(envelope.projectId, 'projectId');
  assertNonEmptyString(envelope.rootSessionId, 'rootSessionId');
  if (!Array.isArray(envelope.sessions) || !Array.isArray(envelope.messages)) {
    fail('INVALID_ENVELOPE', 'sessions and messages must be arrays');
  }
  assertNoRuntimeIdentity(envelope);
  assertOnlyKeys(envelope as unknown as Record<string, unknown>, [
    'schema',
    'version',
    'exportId',
    'exportedAt',
    'ownerScopeId',
    'projectId',
    'rootSessionId',
    'mode',
    'sessions',
    'messages',
    'lineage',
    'conversationHistory',
    'detachedProvenance',
    'payloadDigest',
  ], 'export');
  if (expectedScope?.ownerScopeId !== undefined && envelope.ownerScopeId !== expectedScope.ownerScopeId) {
    fail('OWNER_SCOPE_MISMATCH', `export belongs to ${envelope.ownerScopeId}`);
  }
  if (expectedScope?.projectId !== undefined && envelope.projectId !== expectedScope.projectId) {
    fail('PROJECT_SCOPE_MISMATCH', `export belongs to ${envelope.projectId}`);
  }

  const sessionIds = new Set<string>();
  for (const session of envelope.sessions) {
    assertObject(session, 'portable session');
    assertOnlyKeys(session as unknown as Record<string, unknown>, [
      'id',
      'ownerScopeId',
      'projectId',
      'title',
      'modelConfig',
      'type',
      'origin',
      'memoryMode',
      'suppressedMemoryEntryIds',
      'readOnly',
      'createdAt',
      'updatedAt',
      'engine',
      'workspace',
      'payloadDigest',
    ], `sessions[${session.id}]`);
    assertObject(session.modelConfig, `sessions[${session.id}].modelConfig`);
    assertOnlyKeys(session.modelConfig as unknown as Record<string, unknown>, [
      'provider',
      'model',
      'protocol',
      'temperature',
      'maxTokens',
      'capabilities',
      'computerUse',
      'promptCaching',
      'thinkingBudget',
      'reasoningEffort',
      'adaptive',
    ], `sessions[${session.id}].modelConfig`);
    if (session.modelConfig.promptCaching) {
      assertObject(
        session.modelConfig.promptCaching,
        `sessions[${session.id}].modelConfig.promptCaching`,
      );
      assertOnlyKeys(
        session.modelConfig.promptCaching as unknown as Record<string, unknown>,
        ['enabled', 'cacheSystem'],
        `sessions[${session.id}].modelConfig.promptCaching`,
      );
    }
    if (session.origin) {
      assertObject(session.origin, `sessions[${session.id}].origin`);
      assertOnlyKeys(
        session.origin as unknown as Record<string, unknown>,
        ['kind', 'name'],
        `sessions[${session.id}].origin`,
      );
    }
    if (session.engine) {
      assertObject(session.engine, `sessions[${session.id}].engine`);
      assertOnlyKeys(
        session.engine as unknown as Record<string, unknown>,
        ['kind', 'model', 'permissionProfile', 'origin'],
        `sessions[${session.id}].engine`,
      );
    }
    if (session.workspace) {
      validatePortableSessionWorkspaceV2(
        session.workspace,
        `sessions[${session.id}].workspace`,
      );
    }
    if (sessionIds.has(session.id)) {
      fail('REFERENCE_NOT_CLOSED', `duplicate session id ${session.id}`);
    }
    sessionIds.add(session.id);
    if (session.ownerScopeId !== envelope.ownerScopeId) {
      fail('OWNER_SCOPE_MISMATCH', `session ${session.id} owner differs from export`);
    }
    if (session.projectId !== envelope.projectId) {
      fail('PROJECT_SCOPE_MISMATCH', `session ${session.id} project differs from export`);
    }
    assertDigest(
      session.payloadDigest,
      portabilityDigest(withoutDigest(session)),
      `session ${session.id}`,
    );
  }
  if (!sessionIds.has(envelope.rootSessionId)) {
    fail('REFERENCE_NOT_CLOSED', `root session ${envelope.rootSessionId} is not exported`);
  }

  validateMessageOrdinals(envelope.messages, sessionIds);
  const messageIds = new Set(envelope.messages.map((item) => item.id));
  const messageSessionById = new Map(envelope.messages.map((item) => [item.id, item.sessionId]));
  validateForkLineageEnvelopeV1(envelope.lineage, {
    ownerScopeId: envelope.ownerScopeId,
    projectId: envelope.projectId,
    sessionIds,
    messageIds,
  }, messageSessionById);
  const lineageSessions = new Set(envelope.lineage.nodes.map((item) => item.sessionId));
  if (
    lineageSessions.size !== sessionIds.size
    || [...sessionIds].some((sessionId) => !lineageSessions.has(sessionId))
  ) {
    fail('REFERENCE_NOT_CLOSED', 'lineage nodes must exactly cover exported sessions');
  }
  if (envelope.lineage.rootSessionId !== envelope.rootSessionId) {
    fail('LINEAGE_INVALID', 'lineage and export roots differ');
  }
  if (envelope.conversationHistory) {
    validatePortableConversationHistory(envelope.conversationHistory);
    const expectedHistoryOwner = envelope.ownerScopeId === LOCAL_SESSION_FORK_OWNER_SCOPE_ID
      ? null
      : envelope.ownerScopeId;
    if (envelope.conversationHistory.ownerUserId !== expectedHistoryOwner) {
      fail('OWNER_SCOPE_MISMATCH', 'conversation history owner differs from export');
    }
    if (envelope.conversationHistory.projectId !== envelope.projectId) {
      fail('PROJECT_SCOPE_MISMATCH', 'conversation history project differs from export');
    }
    const historySessionIds = new Set(
      envelope.conversationHistory.branches.map((branch) => branch.sessionId),
    );
    if (
      historySessionIds.size !== sessionIds.size
      || [...sessionIds].some((sessionId) => !historySessionIds.has(sessionId))
    ) {
      fail('REFERENCE_NOT_CLOSED', 'conversation history must exactly cover exported sessions');
    }
  }

  if (envelope.mode === 'detached_child') {
    if (envelope.sessions.length !== 1 || !envelope.detachedProvenance) {
      fail('DETACHED_PROVENANCE_REQUIRED', 'detached child export requires exactly one session and provenance');
    }
    if (
      envelope.lineage.nodes.length !== 1
      || envelope.lineage.nodes[0].parentSessionId !== null
      || envelope.lineage.nodes[0].depth !== 0
    ) {
      fail('LINEAGE_INVALID', 'detached child must be represented as a local root');
    }
    assertObject(envelope.detachedProvenance, 'detached provenance');
    assertOnlyKeys(envelope.detachedProvenance as unknown as Record<string, unknown>, [
      'kind',
      'sourceRootSessionId',
      'sourceParentSessionId',
      'sourceForkId',
      'sourceAnchorMessageId',
      'sourceAnchorDigest',
      'sourceDepth',
    ], 'detachedProvenance');
    assertPortableDigest(
      envelope.detachedProvenance.sourceAnchorDigest,
      'detachedProvenance.sourceAnchorDigest',
    );
  } else if (envelope.detachedProvenance) {
    fail('LINEAGE_INVALID', 'subtree exports cannot carry detached provenance');
  }
  assertDigest(envelope.payloadDigest, portabilityDigest(withoutDigest(envelope)), 'session export envelope');
}

export function rehashSessionExportEnvelopeV2(
  envelope: Omit<SessionExportEnvelopeV2, 'payloadDigest'> | SessionExportEnvelopeV2,
): SessionExportEnvelopeV2 {
  const unsigned = 'payloadDigest' in envelope ? withoutDigest(envelope) : envelope;
  const normalized = {
    ...unsigned,
    sessions: unsigned.sessions.map(rehashSession),
    messages: unsigned.messages.map(rehashMessage),
    lineage: rehashLineageEnvelope(unsigned.lineage),
  };
  return { ...normalized, payloadDigest: portabilityDigest(normalized) };
}

export function buildSessionExportEnvelopeV2(
  input: BuildSessionExportEnvelopeV2Input,
): SessionExportEnvelopeV2 {
  if (input.mode === 'detached_child' && (input.sessions.length !== 1 || !input.detachedProvenance)) {
    fail('DETACHED_PROVENANCE_REQUIRED', 'detached child export requires exactly one session and provenance');
  }
  if (input.sessions.length === 0) {
    fail('INVALID_ENVELOPE', 'at least one session is required');
  }
  const sessions = input.sessions.map((source) => sanitizeSession(
    source,
    input.ownerScopeId,
    input.projectId,
  ));
  const messages = input.sessions.flatMap(sanitizeMessages);
  const lineage = input.mode === 'detached_child'
    ? detachedLineage(sessions[0], messages, input.exportedAt)
    : input.lineage
      ? lineageFromDraft(
        input.lineage,
        input.ownerScopeId,
        input.projectId,
        input.rootSessionId,
      )
      : detachedLineage(sessions[0], messages, input.exportedAt);
  const unsigned: Omit<SessionExportEnvelopeV2, 'payloadDigest'> = {
    schema: SESSION_EXPORT_ENVELOPE_SCHEMA,
    version: SESSION_EXPORT_ENVELOPE_VERSION,
    exportId: input.exportId,
    exportedAt: input.exportedAt,
    ownerScopeId: input.ownerScopeId,
    projectId: input.projectId,
    rootSessionId: input.rootSessionId,
    mode: input.mode,
    sessions,
    messages,
    lineage,
    ...(input.conversationHistory
      ? { conversationHistory: deepPortableClone(input.conversationHistory) }
      : {}),
    ...(input.detachedProvenance
      ? {
        detachedProvenance: {
          kind: 'detached_child',
          ...input.detachedProvenance,
        },
      }
      : {}),
  };
  const envelope = rehashSessionExportEnvelopeV2(unsigned);
  validateSessionExportEnvelopeV2(envelope, {
    ownerScopeId: input.ownerScopeId,
    projectId: input.projectId,
  });
  return envelope;
}

export function encodeSessionExportEnvelopeV2(envelope: SessionExportEnvelopeV2): string {
  validateSessionExportEnvelopeV2(envelope);
  return canonicalJson(envelope);
}

export function decodeSessionExportEnvelopeV2(
  value: string | unknown,
  scope?: SessionExportDecodeScope,
): SessionExportEnvelopeV2 {
  const parsed = parseJson(value, 'session export envelope');
  assertObject(parsed, 'session export envelope');
  const envelope = parsed as unknown as SessionExportEnvelopeV2;
  validateSessionExportEnvelopeV2(envelope, scope);
  return deepPortableClone(envelope);
}

export function stripLegacyForkClaims(value: unknown): LegacyForkClaimStripResult {
  const strippedPaths: string[] = [];
  const visit = (item: unknown, path: string): unknown => {
    if (Array.isArray(item)) {
      return item.map((entry, index) => visit(entry, `${path}[${index}]`));
    }
    if (!item || typeof item !== 'object') return item;
    const output: Record<string, unknown> = {};
    const entries = Object.entries(item as Record<string, unknown>).sort(([left], [right]) => (
      left.localeCompare(right)
    ));
    for (const [key, child] of entries) {
      if (key === 'forkLineage' || key === 'parentSessionId') {
        strippedPaths.push(`${path}.${key}`);
        continue;
      }
      output[key] = visit(child, `${path}.${key}`);
    }
    return output;
  };
  const sanitized = visit(value, '$');
  strippedPaths.sort();
  return { value: sanitized, strippedPaths };
}
