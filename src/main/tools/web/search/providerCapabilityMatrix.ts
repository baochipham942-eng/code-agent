import type { getConfigService } from '../../../services/core/configService';
import type { SearchSourceResult } from './searchTypes';
import { getSearchErrorCircuitBreakerCooldown } from './searchUtils';

export type SearchProviderId =
  | 'firecrawl'
  | 'cloud'
  | 'perplexity'
  | 'openai'
  | 'exa'
  | 'tavily'
  | 'brave';

export type PremiumSearchProviderId = 'perplexity' | 'openai' | 'exa' | 'tavily';

export interface ProviderCapability {
  id: SearchProviderId;
  recency: 'hard' | 'best_effort' | 'none';
  domainFilter: 'native' | 'query_suffix' | 'none';
  citations: 'native' | 'url_extract' | 'none';
  keyPool: boolean;
  reliability: 'infra' | 'premium' | 'best_effort';
}

export interface ProviderHealth {
  provider: SearchProviderId;
  configured: boolean;
  available: boolean;
  totalKeys: number;
  availableKeys: number;
  coolingDownKeys: number;
  cooldownRemainingMs: number;
}

export interface ProviderCapabilityStatus extends ProviderCapability {
  health: ProviderHealth;
}

type KeyConfig = {
  poolEnv: string;
  singleEnv: string;
};

const PREMIUM_KEY_CONFIG: Record<PremiumSearchProviderId, KeyConfig> = {
  perplexity: { poolEnv: 'PERPLEXITY_API_KEYS', singleEnv: 'PERPLEXITY_API_KEY' },
  openai: { poolEnv: 'OPENAI_API_KEYS', singleEnv: 'OPENAI_API_KEY' },
  exa: { poolEnv: 'EXA_API_KEYS', singleEnv: 'EXA_API_KEY' },
  tavily: { poolEnv: 'TAVILY_API_KEYS', singleEnv: 'TAVILY_API_KEY' },
};

export const SEARCH_PROVIDER_CAPABILITIES: Record<SearchProviderId, ProviderCapability> = {
  firecrawl: {
    id: 'firecrawl',
    recency: 'hard',
    domainFilter: 'native',
    citations: 'url_extract',
    keyPool: false,
    reliability: 'infra',
  },
  cloud: {
    id: 'cloud',
    recency: 'none',
    domainFilter: 'native',
    citations: 'native',
    keyPool: false,
    reliability: 'infra',
  },
  perplexity: {
    id: 'perplexity',
    recency: 'none',
    domainFilter: 'query_suffix',
    citations: 'native',
    keyPool: true,
    reliability: 'premium',
  },
  openai: {
    id: 'openai',
    recency: 'best_effort',
    domainFilter: 'native',
    citations: 'native',
    keyPool: true,
    reliability: 'premium',
  },
  exa: {
    id: 'exa',
    recency: 'hard',
    domainFilter: 'native',
    citations: 'none',
    keyPool: true,
    reliability: 'premium',
  },
  tavily: {
    id: 'tavily',
    recency: 'hard',
    domainFilter: 'native',
    citations: 'none',
    keyPool: true,
    reliability: 'premium',
  },
  brave: {
    id: 'brave',
    recency: 'hard',
    domainFilter: 'query_suffix',
    citations: 'url_extract',
    keyPool: false,
    reliability: 'premium',
  },
};

type KeyCooldown = {
  until: number;
  reason: string;
};

const providerKeyCooldowns: Partial<Record<PremiumSearchProviderId, Record<string, KeyCooldown>>> = {};

function splitPool(value: string | undefined): string[] {
  return value ? value.split(/[\s,]+/) : [];
}

function dedupeKeys(keys: string[]): string[] {
  return [...new Set(keys.map(key => key.trim()).filter(Boolean))];
}

function isPremiumProvider(provider: string): provider is PremiumSearchProviderId {
  return provider in PREMIUM_KEY_CONFIG;
}

function getCooldown(provider: PremiumSearchProviderId, key: string): KeyCooldown | undefined {
  const cooldown = providerKeyCooldowns[provider]?.[key];
  if (!cooldown) return undefined;
  const remaining = cooldown.until - Date.now();
  if (remaining <= 0) {
    delete providerKeyCooldowns[provider]?.[key];
    return undefined;
  }
  return cooldown;
}

export function getProviderKeys(
  provider: PremiumSearchProviderId,
  configService: ReturnType<typeof getConfigService>,
): string[] {
  const config = PREMIUM_KEY_CONFIG[provider];
  const raw = [
    ...splitPool(process.env[config.poolEnv]),
    configService?.getServiceApiKey(provider),
    process.env[config.singleEnv],
  ].filter((key): key is string => typeof key === 'string' && key.length > 0);
  return dedupeKeys(raw);
}

export function getTavilyKeys(configService: ReturnType<typeof getConfigService>): string[] {
  return getProviderKeys('tavily', configService);
}

export function getAvailableProviderKeys(
  provider: PremiumSearchProviderId,
  configService: ReturnType<typeof getConfigService>,
): string[] {
  return getProviderKeys(provider, configService).filter(key => !getCooldown(provider, key));
}

export function getProviderHealth(
  provider: SearchProviderId,
  configService: ReturnType<typeof getConfigService>,
): ProviderHealth {
  if (!isPremiumProvider(provider)) {
    return {
      provider,
      configured: true,
      available: true,
      totalKeys: 0,
      availableKeys: 0,
      coolingDownKeys: 0,
      cooldownRemainingMs: 0,
    };
  }

  const keys = getProviderKeys(provider, configService);
  const cooldowns = keys.map(key => getCooldown(provider, key)).filter((value): value is KeyCooldown => Boolean(value));
  const availableKeys = keys.length - cooldowns.length;
  return {
    provider,
    configured: keys.length > 0,
    available: availableKeys > 0,
    totalKeys: keys.length,
    availableKeys,
    coolingDownKeys: cooldowns.length,
    cooldownRemainingMs: cooldowns.length > 0
      ? Math.max(...cooldowns.map(cooldown => cooldown.until - Date.now()))
      : 0,
  };
}

export function getProviderCapabilityMatrix(
  configService: ReturnType<typeof getConfigService>,
): ProviderCapabilityStatus[] {
  return Object.values(SEARCH_PROVIDER_CAPABILITIES).map(capability => ({
    ...capability,
    health: getProviderHealth(capability.id, configService),
  }));
}

export function markProviderKeyCooldown(
  provider: PremiumSearchProviderId,
  key: string,
  error: string | undefined,
): number | null {
  const cooldownMs = getSearchErrorCircuitBreakerCooldown(error);
  if (cooldownMs === null) return null;
  providerKeyCooldowns[provider] ??= {};
  providerKeyCooldowns[provider]![key] = {
    until: Date.now() + cooldownMs,
    reason: error || 'unknown search provider failure',
  };
  return cooldownMs;
}

export function maskProviderKey(key: string): string {
  return key.length <= 12 ? '***' : `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export async function searchWithProviderKeyRotation(
  provider: PremiumSearchProviderId,
  configService: ReturnType<typeof getConfigService>,
  search: (apiKey: string) => Promise<SearchSourceResult>,
): Promise<SearchSourceResult> {
  const allKeys = getProviderKeys(provider, configService);
  if (allKeys.length === 0) {
    return { source: provider, success: false, error: 'API key not configured' };
  }

  const keys = getAvailableProviderKeys(provider, configService);
  if (keys.length === 0) {
    const health = getProviderHealth(provider, configService);
    return {
      source: provider,
      success: false,
      error: `All ${provider} keys are cooling down (${health.coolingDownKeys}/${health.totalKeys}; ${Math.ceil(health.cooldownRemainingMs / 1000)}s remaining)`,
    };
  }

  let lastError = `All ${provider} keys failed`;
  const tried: string[] = [];
  for (const apiKey of keys) {
    tried.push(apiKey);
    const result = await search(apiKey);
    if (result.success) return result;

    lastError = result.error || lastError;
    const cooldownMs = markProviderKeyCooldown(provider, apiKey, result.error);
    if (cooldownMs !== null) {
      continue;
    }
    return result;
  }

  return {
    source: provider,
    success: false,
    error: `${lastError} (tried ${tried.length} key${tried.length > 1 ? 's' : ''}: ${tried.map(maskProviderKey).join(', ')})`,
  };
}

export function resetProviderHealthForTests(): void {
  for (const provider of Object.keys(providerKeyCooldowns) as PremiumSearchProviderId[]) {
    delete providerKeyCooldowns[provider];
  }
}
