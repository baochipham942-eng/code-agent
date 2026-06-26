export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readRecordField(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isJsonRecord(value) ? value : undefined;
}

export function readArrayField(record: JsonRecord, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

export function readChatCompletionText(payload: unknown): string {
  if (!isJsonRecord(payload)) return '';
  const choices = readArrayField(payload, 'choices');
  const first = choices?.[0];
  if (!isJsonRecord(first)) return '';
  const message = readRecordField(first, 'message');
  if (!message) return '';
  const content = readStringField(message, 'content');
  const reasoning = readStringField(message, 'reasoning_content');
  return (content || reasoning || '').trim();
}
