import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function portabilityDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function withoutDigest<T extends { payloadDigest: string }>(
  value: T,
): Omit<T, 'payloadDigest'> {
  const { payloadDigest: _payloadDigest, ...unsigned } = value;
  return unsigned;
}

export function deepPortableClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
