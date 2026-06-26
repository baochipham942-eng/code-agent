import type { ServiceApiKey } from '../../../shared/contract/configService';

const CLOUD_MANAGED_SERVICE_KEY_PREFIX = 'cloud-service-key:';
const CLOUD_MANAGED_SERVICE_BASE_URL_PREFIX = 'serviceBaseUrl.cloud.';

export function getCloudManagedServiceKeyId(service: ServiceApiKey): string {
  return `${CLOUD_MANAGED_SERVICE_KEY_PREFIX}${service}`;
}

export function getCloudManagedServiceBaseUrlId(service: ServiceApiKey): `serviceBaseUrl.${string}` {
  return `${CLOUD_MANAGED_SERVICE_BASE_URL_PREFIX}${service}`;
}

// 内置 provider 托管 key（控制面登录后下发）。前缀必须与服务 key 区分：
// 'openai' 既是 provider 又是 service，共用前缀会串台。
const CLOUD_MANAGED_PROVIDER_KEY_PREFIX = 'cloud-provider-key:';

export function getCloudManagedProviderKeyId(provider: string): string {
  return `${CLOUD_MANAGED_PROVIDER_KEY_PREFIX}${provider}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return null;
    }
    normalized[key] = item;
  }
  return normalized;
}

export function normalizeApiKey(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeBaseUrl(value?: string): string | undefined {
  const normalized = normalizeApiKey(value);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return normalized.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}
