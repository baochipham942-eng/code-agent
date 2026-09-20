import type {
  PortableMessageV2,
  PortableSessionV2,
} from '../../../../shared/contract/sessionForkPortability';
import { SessionForkPortabilityError } from '../../../../shared/contract/sessionForkPortability';
import { portabilityDigest, withoutDigest } from './canonical';

export function fail(code: ConstructorParameters<typeof SessionForkPortabilityError>[0], message: string): never {
  throw new SessionForkPortabilityError(code, message);
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ENVELOPE', `${label} must be an object`);
  }
}

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_ENVELOPE', `${label} must be a non-empty string`);
  }
}

export function assertInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('ORDINAL_INVALID', `${label} must be a non-negative safe integer`);
  }
}

export function assertOnlyKeys(
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

export function assertPortableDigest(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(value)
  ) {
    fail('DIGEST_MISMATCH', `${label} must be a SHA-256 digest`);
  }
}

export function assertDigest(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    fail('DIGEST_MISMATCH', `${label} digest does not match its canonical payload`);
  }
}

export function validatePortableSessionOrigin(
  origin: PortableSessionV2['origin'],
  label: string,
): void {
  if (!origin) return;
  assertObject(origin, `${label}.origin`);
  // N-EXTHISTORY-IMPORT-WIRE: 'metadata' dropped from the allowed origin keys along with
  // codec.ts's external_history branch — see the comment there. Nothing produces this
  // field anymore, so decoding an envelope that still carries one now fails closed
  // instead of validating a shape no writer emits.
  assertOnlyKeys(
    origin as Record<string, unknown>,
    ['kind', 'name'],
    `${label}.origin`,
  );
}

export function validateMessageOrdinals(messages: PortableMessageV2[], sessionIds: ReadonlySet<string>): void {
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
      'contentParts',
      'toolCalls',
      'toolResults',
      'thinking',
      'metadata',
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
    if (message.thinking !== undefined && typeof message.thinking !== 'string') {
      fail('INVALID_ENVELOPE', `message ${message.id} thinking must be a string`);
    }
    const toolCallIds = new Set<string>();
    if (message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls)) {
        fail('INVALID_ENVELOPE', `message ${message.id} toolCalls must be an array`);
      }
      for (const [callIndex, call] of message.toolCalls.entries()) {
        assertObject(call, `message ${message.id} toolCalls[${callIndex}]`);
        assertNonEmptyString(call.id, `message ${message.id} toolCalls[${callIndex}].id`);
        assertNonEmptyString(call.name, `message ${message.id} toolCalls[${callIndex}].name`);
        assertObject(call.arguments, `message ${message.id} toolCalls[${callIndex}].arguments`);
        if (toolCallIds.has(call.id)) {
          fail('REFERENCE_NOT_CLOSED', `message ${message.id} has duplicate tool call id ${call.id}`);
        }
        toolCallIds.add(call.id);
      }
    }
    if (message.toolResults !== undefined) {
      if (!Array.isArray(message.toolResults)) {
        fail('INVALID_ENVELOPE', `message ${message.id} toolResults must be an array`);
      }
      for (const [resultIndex, result] of message.toolResults.entries()) {
        assertObject(result, `message ${message.id} toolResults[${resultIndex}]`);
        assertNonEmptyString(result.toolCallId, `message ${message.id} toolResults[${resultIndex}].toolCallId`);
        if (typeof result.success !== 'boolean') {
          fail('INVALID_ENVELOPE', `message ${message.id} toolResults[${resultIndex}].success must be a boolean`);
        }
      }
    }
    if (message.contentParts !== undefined) {
      if (!Array.isArray(message.contentParts)) {
        fail('INVALID_ENVELOPE', `message ${message.id} contentParts must be an array`);
      }
      for (const [partIndex, part] of message.contentParts.entries()) {
        assertObject(part, `message ${message.id} contentParts[${partIndex}]`);
        const partRecord = part as Record<string, unknown>;
        assertOnlyKeys(
          partRecord,
          partRecord.type === 'text' ? ['type', 'text'] : ['type', 'toolCallId'],
          `message ${message.id} contentParts[${partIndex}]`,
        );
        if (partRecord.type === 'text' && typeof partRecord.text !== 'string') {
          fail('INVALID_ENVELOPE', `message ${message.id} text content part is invalid`);
        }
        if (partRecord.type === 'tool_call') {
          if (typeof partRecord.toolCallId !== 'string') {
            fail('INVALID_ENVELOPE', `message ${message.id} tool content part is invalid`);
          }
          if (!toolCallIds.has(partRecord.toolCallId)) {
            fail(
              'REFERENCE_NOT_CLOSED',
              `message ${message.id} contentParts[${partIndex}] references missing tool call ${partRecord.toolCallId}`,
            );
          }
        }
        if (partRecord.type !== 'text' && partRecord.type !== 'tool_call') {
          fail('INVALID_ENVELOPE', `message ${message.id} content part type is invalid`);
        }
      }
    }
    if (message.metadata !== undefined) {
      assertObject(message.metadata, `message ${message.id} metadata`);
    }
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
