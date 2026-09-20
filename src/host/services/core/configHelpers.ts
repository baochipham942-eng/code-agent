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
 * quick 档旧默认迁移（2026-09-20，R2 扩全）：glm-4-flash 免费档走 bigmodel.cn +
 * ZHIPU_OFFICIAL_API_KEY，官方 key 已失效（401），quick 切到 0ki glm-5.3-flash。
 * 旧默认值一旦随历史 save 落盘就带着旧值 → 存量安装仍在打已死的官方端点。
 * 覆盖 providers.zhipu.model 与其 models map key、routing 各档、taskStrategy.profiles。
 * models map 已有的 glm-5.3-flash 条目优先，不被旧条目覆盖；只迁 zhipu 官方 provider
 * 下的 glm-4-flash，不碰用户显式选的其它模型（第三方中转自报同名是它们自己的事）。
 * 幂等：迁完再跑找不到旧默认即空跑。
 * 返回迁移条数（调用方决定是否记日志）。
 */
export function migrateQuickFreeTierToOkiFlash(models: AppSettings['models']): number {
  const RETIRED_MODEL = 'glm-4-flash';
  const OKI_MODEL = DEFAULT_MODELS.quick;
  const isRetiredQuickFree = (provider: string, model: string | undefined): boolean =>
    provider === 'zhipu' && !!model && model.toLowerCase() === RETIRED_MODEL;

  let migrated = 0;

  const zhipu = models.providers.zhipu;
  if (zhipu) {
    if (isRetiredQuickFree('zhipu', zhipu.model)) {
      zhipu.model = OKI_MODEL;
      migrated += 1;
    }
    const retiredEntry = zhipu.models?.[RETIRED_MODEL];
    if (retiredEntry) {
      // 丢掉旧名 label，回落 catalog 新 label；thinking/maxTokens 等用户档位保留。
      // 已有 glm-5.3-flash 条目优先，不被旧条目覆盖。
      const { label: _retiredLabel, ...retiredSettings } = retiredEntry;
      zhipu.models = {
        ...zhipu.models,
        [OKI_MODEL]: { ...retiredSettings, ...zhipu.models?.[OKI_MODEL] },
      };
      delete zhipu.models[RETIRED_MODEL];
      migrated += 1;
    }
  }

  for (const route of Object.values(models.routing)) {
    if (isRetiredQuickFree(route.provider, route.model)) {
      route.model = OKI_MODEL;
      migrated += 1;
    }
  }

  const profiles = models.taskStrategy?.profiles;
  if (profiles) {
    for (const slot of Object.values(profiles)) {
      if (isRetiredQuickFree(slot.provider, slot.model)) {
        slot.model = OKI_MODEL;
        migrated += 1;
      }
    }
  }

  return migrated;
}
