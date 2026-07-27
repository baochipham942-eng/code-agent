import type {
  PlanSessionForkImportInput,
  SessionForkImportPlan,
} from '../../../../shared/contract/sessionForkPortability';
import { SessionForkPortabilityError } from '../../../../shared/contract/sessionForkPortability';
import { deepPortableClone, portabilityDigest } from './canonical';
import {
  rehashSessionExportEnvelopeV2,
  validateSessionExportEnvelopeV2,
} from './codec';

function portableId(
  namespace: string,
  kind: 'export' | 'session' | 'message' | 'fork',
  sourceId: string,
  sourceDigest: string,
): string {
  const safeNamespace = namespace.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  if (!safeNamespace) {
    throw new SessionForkPortabilityError('INVALID_ENVELOPE', 'import namespace is empty');
  }
  const digest = portabilityDigest({
    namespace,
    kind,
    sourceId,
    sourceDigest,
  }).slice('sha256:'.length, 'sha256:'.length + 24);
  return `import_${safeNamespace}_${kind}_${digest}`;
}

function assertNoRemapCollisions(map: Record<string, string>, label: string): void {
  const targets = Object.values(map);
  if (new Set(targets).size !== targets.length) {
    throw new SessionForkPortabilityError('ID_REMAP_COLLISION', `${label} remap contains duplicate target IDs`);
  }
}

function mapRequired(
  mapping: Readonly<Record<string, string>>,
  sourceId: string,
  label: string,
): string {
  const target = mapping[sourceId];
  if (!target) {
    throw new SessionForkPortabilityError(
      'REFERENCE_NOT_CLOSED',
      `${label} ${sourceId} is outside the import envelope`,
    );
  }
  return target;
}

export function planSessionForkImport(input: PlanSessionForkImportInput): SessionForkImportPlan {
  validateSessionExportEnvelopeV2(input.envelope);
  if (input.envelope.ownerScopeId !== input.targetOwnerScopeId) {
    throw new SessionForkPortabilityError(
      'OWNER_SCOPE_MISMATCH',
      `cannot import owner ${input.envelope.ownerScopeId} into ${input.targetOwnerScopeId}`,
    );
  }
  if (
    input.envelope.projectId !== input.targetProjectId
    && input.allowProjectRemap !== true
  ) {
    throw new SessionForkPortabilityError(
      'PROJECT_SCOPE_MISMATCH',
      `project remap from ${input.envelope.projectId} to ${input.targetProjectId} requires explicit approval`,
    );
  }

  const sessionIdMap = Object.fromEntries(
    [...input.envelope.sessions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => [
        session.id,
        portableId(input.namespace, 'session', session.id, input.envelope.payloadDigest),
      ]),
  );
  const messageIdMap = Object.fromEntries(
    [...input.envelope.messages]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((message) => [
        message.id,
        portableId(input.namespace, 'message', message.id, input.envelope.payloadDigest),
      ]),
  );
  const sourceForkIds = new Set<string>();
  for (const node of input.envelope.lineage.nodes) {
    if (node.forkId) sourceForkIds.add(node.forkId);
  }
  for (const mapping of input.envelope.lineage.messageMappings) {
    sourceForkIds.add(mapping.forkId);
  }
  const forkIdMap = Object.fromEntries(
    [...sourceForkIds]
      .sort((left, right) => left.localeCompare(right))
      .map((forkId) => [
        forkId,
        portableId(input.namespace, 'fork', forkId, input.envelope.payloadDigest),
      ]),
  );
  assertNoRemapCollisions(sessionIdMap, 'session');
  assertNoRemapCollisions(messageIdMap, 'message');
  assertNoRemapCollisions(forkIdMap, 'fork');

  const envelope = deepPortableClone(input.envelope);
  // The portable history is source evidence. Repository import replays it with
  // the deterministic ID maps below, then the target ledger becomes the new
  // truth. Keeping source-scoped IDs inside the remapped target envelope would
  // falsely claim they belong to the target owner/Project.
  delete envelope.conversationHistory;
  envelope.exportId = portableId(
    input.namespace,
    'export',
    input.envelope.exportId,
    input.envelope.payloadDigest,
  );
  envelope.ownerScopeId = input.targetOwnerScopeId;
  envelope.projectId = input.targetProjectId;
  envelope.rootSessionId = mapRequired(sessionIdMap, input.envelope.rootSessionId, 'root session');
  envelope.sessions = envelope.sessions.map((session) => ({
    ...session,
    id: mapRequired(sessionIdMap, session.id, 'session'),
    ownerScopeId: input.targetOwnerScopeId,
    projectId: input.targetProjectId,
  }));
  envelope.messages = envelope.messages.map((message) => ({
    ...message,
    id: mapRequired(messageIdMap, message.id, 'message'),
    sessionId: mapRequired(sessionIdMap, message.sessionId, 'message session'),
  }));
  envelope.lineage.ownerScopeId = input.targetOwnerScopeId;
  envelope.lineage.projectId = input.targetProjectId;
  envelope.lineage.rootSessionId = envelope.rootSessionId;
  envelope.lineage.nodes = envelope.lineage.nodes.map((node) => ({
    ...node,
    forkId: node.forkId ? mapRequired(forkIdMap, node.forkId, 'fork') : null,
    sessionId: mapRequired(sessionIdMap, node.sessionId, 'lineage session'),
    parentSessionId: node.parentSessionId
      ? mapRequired(sessionIdMap, node.parentSessionId, 'lineage parent')
      : null,
    rootSessionId: envelope.rootSessionId,
    sourceAnchorMessageId: node.sourceAnchorMessageId
      ? mapRequired(messageIdMap, node.sourceAnchorMessageId, 'source anchor')
      : null,
    anchorChildMessageId: node.anchorChildMessageId
      ? mapRequired(messageIdMap, node.anchorChildMessageId, 'child anchor')
      : null,
    ownerScopeId: input.targetOwnerScopeId,
    projectId: input.targetProjectId,
  }));
  envelope.lineage.messageMappings = envelope.lineage.messageMappings.map((mapping) => ({
    ...mapping,
    forkId: mapRequired(forkIdMap, mapping.forkId, 'mapping fork'),
    sourceSessionId: mapRequired(sessionIdMap, mapping.sourceSessionId, 'mapping source session'),
    childSessionId: mapRequired(sessionIdMap, mapping.childSessionId, 'mapping child session'),
    sourceMessageId: mapRequired(messageIdMap, mapping.sourceMessageId, 'mapping source message'),
    childMessageId: mapRequired(messageIdMap, mapping.childMessageId, 'mapping child message'),
  }));

  const rehashed = rehashSessionExportEnvelopeV2(envelope);
  validateSessionExportEnvelopeV2(rehashed, {
    ownerScopeId: input.targetOwnerScopeId,
    projectId: input.targetProjectId,
  });
  return {
    sourceExportId: input.envelope.exportId,
    targetOwnerScopeId: input.targetOwnerScopeId,
    targetProjectId: input.targetProjectId,
    sessionIdMap,
    messageIdMap,
    forkIdMap,
    envelope: rehashed,
  };
}
