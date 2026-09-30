interface FeishuCardActionPayload {
  value: string;
  operatorOpenId?: string;
  chatId?: string;
  verificationConfigured: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function buildFeishuCardActionPayload(
  bodyRecord: Record<string, unknown>,
  eventPayload: Record<string, unknown> | undefined,
  value: string | undefined,
  verificationConfigured: boolean,
): FeishuCardActionPayload | undefined {
  if (value === undefined) return undefined;
  const operator = readRecordField(bodyRecord, 'operator') ?? (eventPayload && readRecordField(eventPayload, 'operator'));
  const context = readRecordField(bodyRecord, 'context') ?? (eventPayload && readRecordField(eventPayload, 'context'));
  const operatorOpenId = readStringField(operator ?? {}, 'open_id') ?? readStringField(bodyRecord, 'open_id')
    ?? (eventPayload && readStringField(eventPayload, 'open_id'));
  const chatId = readStringField(bodyRecord, 'open_chat_id') ?? readStringField(bodyRecord, 'chat_id')
    ?? readStringField(context ?? {}, 'open_chat_id') ?? (eventPayload && readStringField(eventPayload, 'open_chat_id'))
    ?? (eventPayload && readStringField(eventPayload, 'chat_id'));
  return { value, operatorOpenId, chatId, verificationConfigured };
}
