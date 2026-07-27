import type {
  ConversationBoundary,
  ConversationLineageIssueCode,
  ConversationMessageSnapshot,
} from '../../../../shared/contract/conversationBranch';
import { deepPortableClone, portabilityDigest } from './canonical';
import {
  conversationHistoryCodecInternals,
  validatePortableConversationHistory,
} from './conversationHistory';
import type {
  PlanPortableConversationHistoryImportInput,
  PortableConversationEntry,
  PortableConversationEvent,
  PortableConversationHistoryErrorCode,
  PortableConversationHistoryImportPlan,
  PortableConversationReference,
  PortableConversationReplayAction,
  PortableConversationReplayActionWithoutOrder,
  PortableProjectionIssueType,
  PortableProjectionRepairSourceEvidence,
} from './conversationHistoryTypes';

const PROJECTION_REPAIR_ISSUE_TYPES = new Set<PortableProjectionIssueType>([
  'PROJECTION_ALIAS_MISSING',
  'PROJECTION_ALIAS_EXTRA',
  'PROJECTION_ALIAS_ORDER_MISMATCH',
  'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
]);

function fail(code: PortableConversationHistoryErrorCode, message: string): never {
  return conversationHistoryCodecInternals.fail(code, message);
}

function requiredString(value: unknown, label: string): string {
  return conversationHistoryCodecInternals.requiredString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  return conversationHistoryCodecInternals.nonNegativeInteger(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  return conversationHistoryCodecInternals.stringArray(value, label);
}

function numberArray(value: unknown, label: string): number[] {
  return conversationHistoryCodecInternals.numberArray(value, label);
}

function exactDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    fail('INVALID_HISTORY', `${label} must be a lowercase sha256 digest`);
  }
  return digest;
}

function quarantineIssueTypes(
  quarantine: PortableConversationEvent,
): ConversationLineageIssueCode[] {
  if (!Array.isArray(quarantine.payload.issues) || quarantine.payload.issues.length === 0) {
    fail('INVALID_HISTORY', `quarantine event ${quarantine.id} has no issue evidence`);
  }
  return [...new Set(quarantine.payload.issues.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('INVALID_HISTORY', `event ${quarantine.id}.issues[${index}] must be an object`);
    }
    return requiredString(
      (item as Record<string, unknown>).code,
      `event ${quarantine.id}.issues[${index}].code`,
    ) as ConversationLineageIssueCode;
  }))].sort();
}

function projectionRepairSourceEvidence(
  repair: PortableConversationEvent,
  eventsById: ReadonlyMap<string, PortableConversationEvent>,
): PortableProjectionRepairSourceEvidence {
  const sourceQuarantineEventId = requiredString(
    repair.payload.quarantineEventId,
    `event ${repair.id}.quarantineEventId`,
  );
  const quarantine = eventsById.get(sourceQuarantineEventId);
  if (
    quarantine?.eventType !== 'quarantine'
    || quarantine?.branchId !== repair.branchId
    || (quarantine?.sequence ?? Number.NaN) + 1 !== repair.sequence
  ) {
    fail(
      'REFERENCE_NOT_CLOSED',
      `projection repair ${repair.id} must immediately follow its same-branch quarantine`,
    );
  }
  const sourceIssueDigest = exactDigest(
    repair.payload.issueDigest,
    `event ${repair.id}.issueDigest`,
  );
  if (
    exactDigest(
      quarantine.payload.issueDigest,
      `event ${quarantine.id}.issueDigest`,
    ) !== sourceIssueDigest
  ) {
    fail(
      'DIGEST_MISMATCH',
      `projection repair ${repair.id} does not match its source quarantine digest`,
    );
  }
  const issueTypes = quarantineIssueTypes(quarantine).map((code) => {
    if (!PROJECTION_REPAIR_ISSUE_TYPES.has(code as PortableProjectionIssueType)) {
      fail(
        'INVALID_HISTORY',
        `projection repair ${repair.id} requires projection-only evidence; found ${code}`,
      );
    }
    return code as PortableProjectionIssueType;
  });
  exactDigest(
    repair.payload.previousProjectionDigest,
    `event ${repair.id}.previousProjectionDigest`,
  );
  exactDigest(
    repair.payload.repairedProjectionDigest,
    `event ${repair.id}.repairedProjectionDigest`,
  );
  for (const field of [
    'expectedActiveCount',
    'previousActiveCount',
    'insertedCount',
    'updatedCount',
    'softHiddenCount',
    'reorderedCount',
    'recalibratedForkMappingCount',
  ]) {
    nonNegativeInteger(repair.payload[field], `event ${repair.id}.${field}`);
  }
  return {
    sourceIssueDigest,
    sourceQuarantineEventId,
    quarantineCreatedAt: quarantine.createdAt,
    quarantineIdempotencyKey: actionIdempotencyKey(
      repair.payloadDigest,
      quarantine.id,
      'auditAndQuarantine',
    ),
    issueTypes,
  };
}

function requireMapped(
  mapping: Readonly<Record<string, string>>,
  sourceId: string,
  kind: string,
): string {
  const target = mapping[sourceId];
  if (typeof target !== 'string' || target.trim().length === 0) {
    fail('MAPPING_MISSING', `${kind} ${sourceId} has no target mapping`);
  }
  return target;
}

function assertMappingUnique(mapping: Readonly<Record<string, string>>, kind: string): void {
  const values = Object.values(mapping);
  if (new Set(values).size !== values.length) {
    fail('MAPPING_COLLISION', `${kind} target mapping contains a collision`);
  }
}

function derivedId(kind: 'rewind' | 'evaluation', historyDigest: string, sourceId: string): string {
  const digest = portabilityDigest({ kind, historyDigest, sourceId }).slice('sha256:'.length, 40);
  return `import_${kind}_${digest}`;
}

function actionIdempotencyKey(
  historyDigest: string,
  sourceEventId: string,
  method: PortableConversationReplayAction['method'],
  index = 0,
): string {
  return `portability:${portabilityDigest({
    historyDigest,
    sourceEventId,
    method,
    index,
  }).slice('sha256:'.length, 48)}`;
}

interface ActionGroup {
  key: string;
  branchId: string;
  sequence: number;
  sourceEventId: string;
  createdAt: number;
  stableRank: number;
  dependencies: Set<string>;
  actions: PortableConversationReplayActionWithoutOrder[];
}

function referenceByOrdinal(
  references: ReadonlyMap<string, PortableConversationReference>,
  branchId: string,
  ordinal: number,
): PortableConversationReference {
  const reference = references.get(`${branchId}:${ordinal}`);
  if (!reference) {
    fail('REFERENCE_NOT_CLOSED', `branch ${branchId} has no reference at ordinal ${ordinal}`);
  }
  return reference;
}

function eventOrdinals(event: PortableConversationEvent): number[] {
  switch (event.eventType) {
    case 'legacy_backfill':
    case 'fork':
      return numberArray(event.payload.ordinals ?? [], `event ${event.id}.ordinals`);
    case 'append':
      return [nonNegativeInteger(event.payload.ordinal, `event ${event.id}.ordinal`)];
    case 'message_revision':
      return [nonNegativeInteger(
        event.payload.replacementOrdinal,
        `event ${event.id}.replacementOrdinal`,
      )];
    case 'projection_replace':
      return numberArray(
        event.payload.replacementOrdinals,
        `event ${event.id}.replacementOrdinals`,
      );
    default:
      return [];
  }
}

function messageForReference(
  reference: PortableConversationReference,
  entries: ReadonlyMap<string, PortableConversationEntry>,
  messageIdMap: Readonly<Record<string, string>>,
): ConversationMessageSnapshot {
  const entry = entries.get(reference.entryId);
  if (!entry) fail('REFERENCE_NOT_CLOSED', `entry ${reference.entryId} is missing`);
  return {
    ...deepPortableClone(entry.message),
    id: requireMapped(messageIdMap, reference.projectedMessageId, 'message'),
    visibility: 'active',
  };
}

function producerKey(
  producerByReference: ReadonlyMap<string, string>,
  branchId: string,
  ordinal: number,
): string {
  const producer = producerByReference.get(`${branchId}:${ordinal}`);
  if (!producer) {
    fail(
      'REFERENCE_NOT_CLOSED',
      `branch ${branchId} reference ${ordinal} has no immutable producer event`,
    );
  }
  return producer;
}

export function planPortableConversationHistoryImport(
  input: PlanPortableConversationHistoryImportInput,
): PortableConversationHistoryImportPlan {
  validatePortableConversationHistory(input.history);
  assertMappingUnique(input.sessionIdMap, 'session');
  assertMappingUnique(input.messageIdMap, 'message');
  assertMappingUnique(input.forkIdMap, 'fork');
  const boundary: ConversationBoundary = {
    ownerUserId: input.targetOwnerUserId,
    projectId: input.targetProjectId,
  };
  const branches = new Map(input.history.branches.map((branch) => [branch.id, branch]));
  const entries = new Map(input.history.entries.map((entry) => [entry.id, entry]));
  const references = new Map(input.history.references.map((reference) => [
    `${reference.branchId}:${reference.ordinal}`,
    reference,
  ]));
  const referencesByBranch = new Map<string, PortableConversationReference[]>();
  for (const reference of input.history.references) {
    requireMapped(input.sessionIdMap, reference.projectedSessionId, 'session');
    requireMapped(input.messageIdMap, reference.projectedMessageId, 'message');
    const grouped = referencesByBranch.get(reference.branchId) ?? [];
    grouped.push(reference);
    referencesByBranch.set(reference.branchId, grouped);
  }
  for (const branch of input.history.branches) {
    requireMapped(input.sessionIdMap, branch.sessionId, 'session');
    if (branch.forkId) requireMapped(input.forkIdMap, branch.forkId, 'fork');
  }
  const rewindIds = new Set<string>();
  const evaluationIds = new Set(
    input.history.evaluationAttributions.map((evaluation) => evaluation.evaluationId),
  );
  for (const event of input.history.events) {
    if (event.eventType === 'rewind' || event.eventType === 'rewind_restore') {
      rewindIds.add(requiredString(event.payload.rewindId, `event ${event.id}.rewindId`));
    }
  }
  const rewindIdMap = Object.fromEntries([...rewindIds].sort().map((sourceId) => [
    sourceId,
    derivedId('rewind', input.history.payloadDigest, sourceId),
  ]));
  const evaluationIdMap = Object.fromEntries([...evaluationIds].sort().map((sourceId) => [
    sourceId,
    derivedId('evaluation', input.history.payloadDigest, sourceId),
  ]));
  const evaluations = new Map(
    input.history.evaluationAttributions.map((evaluation) => [evaluation.eventId, evaluation]),
  );
  const eventsById = new Map(input.history.events.map((event) => [event.id, event]));
  const projectionRepairEvidenceByEvent = new Map<
    string,
    PortableProjectionRepairSourceEvidence
  >();
  const projectionRepairQuarantineIds = new Set<string>();
  for (const event of input.history.events) {
    if (event.eventType !== 'projection_repair') continue;
    const evidence = projectionRepairSourceEvidence(event, eventsById);
    if (projectionRepairQuarantineIds.has(evidence.sourceQuarantineEventId)) {
      fail(
        'REFERENCE_NOT_CLOSED',
        `quarantine ${evidence.sourceQuarantineEventId} is reused by multiple projection repairs`,
      );
    }
    projectionRepairQuarantineIds.add(evidence.sourceQuarantineEventId);
    projectionRepairEvidenceByEvent.set(event.id, evidence);
  }
  const eventRank = new Map(input.history.events.map((event, index) => [event.id, index]));
  const groups = new Map<string, ActionGroup>();
  const lastGroupByBranch = new Map<string, string>();
  const producerByReference = new Map<string, string>();

  for (const branch of input.history.branches) {
    if (branch.parentBranchId) continue;
    const key = `init:${branch.id}`;
    groups.set(key, {
      key,
      branchId: branch.id,
      sequence: 0,
      sourceEventId: key,
      createdAt: branch.createdAt,
      stableRank: -1,
      dependencies: new Set(),
      actions: [{
        method: 'initializeSessionBranch',
        sourceEventId: key,
        createdAt: branch.createdAt,
        input: {
          sessionId: requireMapped(input.sessionIdMap, branch.sessionId, 'session'),
          boundary,
          createdAt: branch.createdAt,
        },
      }],
    });
    lastGroupByBranch.set(branch.id, key);
  }

  for (const event of input.history.events) {
    const branch = branches.get(event.branchId);
    if (!branch) fail('REFERENCE_NOT_CLOSED', `event ${event.id} branch is missing`);
    const key = `event:${event.id}`;
    const previous = lastGroupByBranch.get(branch.id);
    groups.set(key, {
      key,
      branchId: branch.id,
      sequence: event.sequence,
      sourceEventId: event.id,
      createdAt: event.createdAt,
      stableRank: eventRank.get(event.id) ?? Number.MAX_SAFE_INTEGER,
      dependencies: new Set(previous ? [previous] : []),
      actions: [],
    });
    lastGroupByBranch.set(branch.id, key);
    for (const ordinal of eventOrdinals(event)) {
      const reference = referenceByOrdinal(references, branch.id, ordinal);
      if (producerByReference.has(`${branch.id}:${ordinal}`)) {
        fail('ORDER_INVALID', `branch ${branch.id} reference ${ordinal} has multiple producer events`);
      }
      producerByReference.set(`${branch.id}:${ordinal}`, key);
      if (reference.branchId !== branch.id) {
        fail('REFERENCE_NOT_CLOSED', `event ${event.id} reference branch mismatch`);
      }
    }
  }

  for (const event of input.history.events) {
    const branch = branches.get(event.branchId);
    const group = groups.get(`event:${event.id}`);
    if (!branch || !group) fail('REFERENCE_NOT_CLOSED', `event ${event.id} is not planned`);
    const sessionId = requireMapped(input.sessionIdMap, branch.sessionId, 'session');
    const idempotencyKey = (method: PortableConversationReplayAction['method'], index = 0) => (
      actionIdempotencyKey(input.history.payloadDigest, event.id, method, index)
    );
    const snapshot = (ordinal: number) => messageForReference(
      referenceByOrdinal(references, branch.id, ordinal),
      entries,
      input.messageIdMap,
    );
    const append = (
      ordinal: number,
      index = 0,
    ): PortableConversationReplayActionWithoutOrder => {
      const reference = referenceByOrdinal(references, branch.id, ordinal);
      const entry = entries.get(reference.entryId);
      if (!entry) fail('REFERENCE_NOT_CLOSED', `entry ${reference.entryId} is missing`);
      return {
        method: 'appendMessage',
        sourceEventId: event.id,
        createdAt: event.createdAt,
        input: {
          sessionId,
          boundary,
          message: snapshot(ordinal),
          idempotencyKey: idempotencyKey('appendMessage', index),
          provenance: {
            kind: 'portable_conversation_history',
            sourceHistoryDigest: input.history.payloadDigest,
            sourceEntryDigest: entry.payloadDigest,
            sourceEventDigest: event.payloadDigest,
          },
          createdAt: event.createdAt,
        },
      };
    };

    switch (event.eventType) {
      case 'legacy_backfill':
        if (branch.parentBranchId) {
          fail('UNSUPPORTED_EVENT', `fork branch ${branch.id} cannot be restored as legacy root`);
        }
        group.actions.push(...eventOrdinals(event).map((ordinal, index) => append(ordinal, index)));
        break;
      case 'append':
        group.actions.push(append(nonNegativeInteger(
          event.payload.ordinal,
          `event ${event.id}.ordinal`,
        )));
        break;
      case 'message_revision': {
        const replacementOrdinal = nonNegativeInteger(
          event.payload.replacementOrdinal,
          `event ${event.id}.replacementOrdinal`,
        );
        group.actions.push({
          method: 'recordMessageRevision',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            targetMessageId: requireMapped(
              input.messageIdMap,
              requiredString(event.payload.projectedMessageId, `event ${event.id}.projectedMessageId`),
              'message',
            ),
            revisedMessage: snapshot(replacementOrdinal),
            idempotencyKey: idempotencyKey('recordMessageRevision'),
            reason: requiredString(event.payload.reason, `event ${event.id}.reason`),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'projection_replace': {
        const replacementOrdinals = numberArray(
          event.payload.replacementOrdinals,
          `event ${event.id}.replacementOrdinals`,
        );
        group.actions.push({
          method: 'recordProjectionReplacement',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            messages: replacementOrdinals.map(snapshot),
            idempotencyKey: idempotencyKey('recordProjectionReplacement'),
            reason: requiredString(event.payload.reason, `event ${event.id}.reason`),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'fork': {
        if (!branch.parentBranchId || !branch.forkId) {
          fail('REFERENCE_NOT_CLOSED', `fork event ${event.id} has no parent lineage`);
        }
        const parent = branches.get(branch.parentBranchId);
        if (!parent) fail('REFERENCE_NOT_CLOSED', `fork event ${event.id} parent branch is missing`);
        const childReferences = [...(referencesByBranch.get(branch.id) ?? [])]
          .filter((reference) => reference.aliasKind === 'fork_copy')
          .sort((left, right) => left.ordinal - right.ordinal);
        if (childReferences.length === 0) {
          fail('REFERENCE_NOT_CLOSED', `fork event ${event.id} has no shared prefix references`);
        }
        const parentReferences = new Map(
          (referencesByBranch.get(parent.id) ?? []).map((reference) => [
            reference.entryId,
            reference,
          ]),
        );
        const aliases = childReferences.map((childReference) => {
          const sourceReference = parentReferences.get(childReference.entryId);
          if (!sourceReference) {
            fail(
              'REFERENCE_NOT_CLOSED',
              `fork event ${event.id} entry ${childReference.entryId} is not shared with its parent`,
            );
          }
          return {
            sourceMessageId: requireMapped(
              input.messageIdMap,
              sourceReference.projectedMessageId,
              'message',
            ),
            childMessageId: requireMapped(
              input.messageIdMap,
              childReference.projectedMessageId,
              'message',
            ),
          };
        });
        const sourceAnchorId = requiredString(
          event.payload.sourceAnchorMessageId,
          `event ${event.id}.sourceAnchorMessageId`,
        );
        const childAnchorId = requiredString(
          event.payload.childAnchorMessageId,
          `event ${event.id}.childAnchorMessageId`,
        );
        const sourceAnchorReference = (referencesByBranch.get(parent.id) ?? [])
          .find((reference) => reference.projectedMessageId === sourceAnchorId);
        if (!sourceAnchorReference) {
          fail('REFERENCE_NOT_CLOSED', `fork event ${event.id} parent anchor is missing`);
        }
        group.dependencies.add(producerKey(
          producerByReference,
          parent.id,
          sourceAnchorReference.ordinal,
        ));
        group.actions.push({
          method: 'createForkBranch',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sourceSessionId: requireMapped(input.sessionIdMap, parent.sessionId, 'session'),
            childSessionId: sessionId,
            sourceAnchorMessageId: requireMapped(input.messageIdMap, sourceAnchorId, 'message'),
            childAnchorMessageId: requireMapped(input.messageIdMap, childAnchorId, 'message'),
            forkId: requireMapped(input.forkIdMap, branch.forkId, 'fork'),
            boundary,
            messageAliases: aliases,
            idempotencyKey: idempotencyKey('createForkBranch'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'rewind': {
        const sourceRewindId = requiredString(
          event.payload.rewindId,
          `event ${event.id}.rewindId`,
        );
        group.actions.push({
          method: 'recordRewind',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            anchorMessageId: requireMapped(
              input.messageIdMap,
              requiredString(event.payload.anchorMessageId, `event ${event.id}.anchorMessageId`),
              'message',
            ),
            hiddenMessageIds: stringArray(
              event.payload.hiddenMessageIds,
              `event ${event.id}.hiddenMessageIds`,
            ).map((messageId) => requireMapped(input.messageIdMap, messageId, 'message')),
            rewindId: requireMapped(rewindIdMap, sourceRewindId, 'rewind'),
            idempotencyKey: idempotencyKey('recordRewind'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'rewind_restore': {
        const sourceRewindId = requiredString(
          event.payload.rewindId,
          `event ${event.id}.rewindId`,
        );
        group.actions.push({
          method: 'recordRewindRestore',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            rewindId: requireMapped(rewindIdMap, sourceRewindId, 'rewind'),
            idempotencyKey: idempotencyKey('recordRewindRestore'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'evaluation_attribution': {
        const evaluation = evaluations.get(event.id);
        if (!evaluation) {
          fail('REFERENCE_NOT_CLOSED', `evaluation event ${event.id} has no attribution record`);
        }
        const branchReferences = referencesByBranch.get(branch.id) ?? [];
        const attributedMessageIds = evaluation.entryIds.map((entryId) => {
          const reference = [...branchReferences].reverse()
            .find((candidate) => candidate.entryId === entryId);
          if (!reference) {
            fail(
              'REFERENCE_NOT_CLOSED',
              `evaluation ${evaluation.eventId} entry ${entryId} has no branch alias`,
            );
          }
          return requireMapped(input.messageIdMap, reference.projectedMessageId, 'message');
        });
        group.actions.push({
          method: 'recordEvaluationAttribution',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            evaluationId: requireMapped(
              evaluationIdMap,
              evaluation.evaluationId,
              'evaluation',
            ),
            runId: null,
            metric: evaluation.metric,
            value: evaluation.value,
            attributedMessageIds,
            idempotencyKey: idempotencyKey('recordEvaluationAttribution'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'quarantine': {
        if (projectionRepairQuarantineIds.has(event.id)) break;
        const expectedIssueDigest = requiredString(
          event.payload.issueDigest,
          `event ${event.id}.issueDigest`,
        );
        group.actions.push({
          method: 'auditAndQuarantine',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          expectedIssueDigest,
          expectedIssueTypes: quarantineIssueTypes(event),
          input: {
            sessionId,
            boundary,
            idempotencyKey: idempotencyKey('auditAndQuarantine'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      case 'projection_repair': {
        const reason = requiredString(event.payload.reason, `event ${event.id}.reason`);
        if (reason.trim().length < 16) {
          fail('INVALID_HISTORY', `projection repair event ${event.id} reason is not substantive`);
        }
        const sourceEvidence = projectionRepairEvidenceByEvent.get(event.id);
        if (!sourceEvidence) {
          fail(
            'REFERENCE_NOT_CLOSED',
            `projection repair event ${event.id} lost its source evidence`,
          );
        }
        group.actions.push({
          method: 'repairCompatibilityProjection',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          input: {
            sessionId,
            boundary,
            reason,
            idempotencyKey: idempotencyKey('repairCompatibilityProjection'),
            createdAt: event.createdAt,
          },
          sourceEvidence,
        });
        break;
      }
      case 'repair_override': {
        const reason = requiredString(event.payload.reason, `event ${event.id}.reason`);
        if (reason.trim().length < 16) {
          fail('INVALID_HISTORY', `repair event ${event.id} reason is not substantive`);
        }
        const sourceQuarantineEventId = requiredString(
          event.payload.quarantineEventId,
          `event ${event.id}.quarantineEventId`,
        );
        const quarantine = eventsById.get(sourceQuarantineEventId);
        const issueDigest = requiredString(
          event.payload.issueDigest,
          `event ${event.id}.issueDigest`,
        );
        if (
          quarantine?.eventType !== 'quarantine'
          || quarantine?.branchId !== event.branchId
          || (quarantine?.sequence ?? Number.MAX_SAFE_INTEGER) >= event.sequence
          || quarantine?.payload.issueDigest !== issueDigest
          || projectionRepairQuarantineIds.has(sourceQuarantineEventId)
        ) {
          fail(
            'REFERENCE_NOT_CLOSED',
            `repair override ${event.id} does not reference its exact source quarantine`,
          );
        }
        group.actions.push({
          method: 'recordRepairOverride',
          sourceEventId: event.id,
          createdAt: event.createdAt,
          sourceQuarantineEventId,
          input: {
            sessionId,
            boundary,
            issueDigest,
            reason,
            idempotencyKey: idempotencyKey('recordRepairOverride'),
            createdAt: event.createdAt,
          },
        });
        break;
      }
      default:
        fail('UNSUPPORTED_EVENT', `event ${event.id} cannot be replayed`);
    }
  }

  for (const branch of input.history.branches) {
    if (!branch.parentBranchId) continue;
    const branchEvents = input.history.events.filter((event) => event.branchId === branch.id);
    if (branchEvents[0]?.eventType !== 'fork') {
      fail('REFERENCE_NOT_CLOSED', `child branch ${branch.id} does not begin with its fork event`);
    }
  }

  const emitted = new Set<string>();
  const orderedGroups: ActionGroup[] = [];
  while (emitted.size < groups.size) {
    const available = [...groups.values()]
      .filter((group) => (
        !emitted.has(group.key)
        && [...group.dependencies].every((dependency) => emitted.has(dependency))
      ))
      .sort((left, right) => (
        left.createdAt - right.createdAt
        || left.stableRank - right.stableRank
        || left.sequence - right.sequence
        || left.key.localeCompare(right.key)
      ));
    const next = available[0];
    if (!next) fail('ORDER_INVALID', 'conversation replay action dependencies contain a cycle');
    orderedGroups.push(next);
    emitted.add(next.key);
  }
  const actions = orderedGroups
    .flatMap((group) => group.actions)
    .map((action, order) => ({ ...action, order })) as PortableConversationReplayAction[];
  const unsignedPlan: Omit<PortableConversationHistoryImportPlan, 'payloadDigest'> = {
    sourceHistoryDigest: input.history.payloadDigest,
    targetBoundary: boundary,
    rewindIdMap,
    evaluationIdMap,
    actions,
  };
  conversationHistoryCodecInternals.assertStructurallyPrivate(unsignedPlan);
  return {
    ...unsignedPlan,
    payloadDigest: portabilityDigest(unsignedPlan),
  };
}
