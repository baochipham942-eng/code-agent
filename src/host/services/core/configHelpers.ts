import type { ServiceApiKey } from '../../../shared/contract/configService';
import type { AppSettings } from '../../../shared/contract';
import { DEFAULT_MODELS } from '../../../shared/constants';

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

/**
 * quick 档旧默认迁移（2026-09-20）：quick 档历史默认 zhipu/glm-4-flash 是免费档，走 bigmodel.cn +
 * ZHIPU_OFFICIAL_API_KEY；默认切到 0ki glm-5.3-flash 后，随历史 save 落盘的旧默认仍会打旧端点。
 * 只迁 quick 档自己的两个槽：`routing.fast` 与 `taskStrategy.profiles.fast`。
 * glm-4-flash 仍在 catalog/registry 里可选（ponytail: 不真退役），所以 providers.zhipu.model、
 * 其它 routing 档位、models map 条目一律不碰——那些位置的值只能来自用户显式选择。
 * 幂等：迁完再跑找不到旧默认即空跑。返回迁移条数（调用方决定是否记日志）。
 */
export function migrateQuickFreeTierToOkiFlash(models: AppSettings['models']): number {
  const RETIRED_QUICK_DEFAULT = 'glm-4-flash';
  const isRetiredQuickDefault = (slot: { provider: string; model?: string }): boolean =>
    slot.provider === 'zhipu' && slot.model?.toLowerCase() === RETIRED_QUICK_DEFAULT;

  let migrated = 0;
  for (const slot of [models.routing.fast, models.taskStrategy?.profiles?.fast]) {
    if (slot && isRetiredQuickDefault(slot)) {
      slot.model = DEFAULT_MODELS.quick;
      migrated += 1;
    }
  }
  return migrated;
}
