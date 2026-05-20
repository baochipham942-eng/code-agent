export interface BridgeDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecordField(record: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = record[field];
  return isRecord(value) ? value : null;
}

function getStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function getArrayField(record: Record<string, unknown>, field: string): unknown[] | null {
  const value = record[field];
  return Array.isArray(value) ? value : null;
}

export async function invokeLocalBridgeTool(
  token: string | null,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch('http://localhost:9527/tools/invoke', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tool,
      params,
      requestId: crypto.randomUUID(),
    }),
  });
  if (!res.ok) throw new Error('桥接服务调用失败');
  return await res.json() as unknown;
}

export function readBridgeHomeDir(data: unknown): string {
  if (!isRecord(data)) return '/';
  const result = getRecordField(data, 'result');
  return (result ? getStringField(result, 'homeDir') : null)
    || getStringField(data, 'homeDir')
    || '/';
}

function normalizeDirectoryEntry(value: unknown): BridgeDirectoryEntry | null {
  if (!isRecord(value)) return null;
  const name = getStringField(value, 'name');
  const path = getStringField(value, 'path');
  if (!name || !path || typeof value.isDirectory !== 'boolean') return null;
  return { name, path, isDirectory: value.isDirectory };
}

export function readBridgeDirectoryEntries(data: unknown): BridgeDirectoryEntry[] {
  if (!isRecord(data)) return [];
  const result = getRecordField(data, 'result');
  const rawEntries = (result ? getArrayField(result, 'entries') : null)
    || getArrayField(data, 'entries')
    || [];

  return rawEntries
    .map(normalizeDirectoryEntry)
    .filter((entry): entry is BridgeDirectoryEntry => Boolean(entry));
}
