// ============================================================================
// Provider IPC Handlers - provider:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  API_VERSIONS,
  getProviderEndpointForProtocol,
  normalizeProviderId,
  MCP,
  getModelMaxOutputTokens,
} from '../../shared/constants';
import type { ModelCapability, ModelProviderProtocol } from '../../shared/contract';
import { inferModelCapabilities, inferSupportsTool } from '../../shared/modelRuntime';
import { runDiagnostics } from './doctor.ipc';
import { runDoctor } from '../diagnostics/doctorRunner';
import type { RunDoctorOptions } from '../diagnostics/types';
import { getProviderHealthMonitor } from '../model/providerHealthMonitor';
import {
  handleTestConnection,
  mapProviderHttpError as mapHttpError,
  resolveConfiguredApiKey,
  trimTrailingSlash,
  type TestConnectionPayload,
  type TestConnectionResult,
} from '../model/providerConnectionTest';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface DiscoverModelsPayload {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: ModelProviderProtocol;
}

export interface DiscoveredProviderModel {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  maxTokens?: number;
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
}

export interface DiscoverModelsResult {
  success: boolean;
  models: DiscoveredProviderModel[];
  latencyMs: number;
  error?: TestConnectionResult['error'];
}

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

function getDiscoveryUrl(
  provider: string,
  baseUrl?: string,
  apiKey?: string,
  protocol?: ModelProviderProtocol,
): { url: string; headers: Record<string, string> } | null {
  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const providerProtocol = protocol ?? (normalizedProvider === 'claude' ? 'claude' : 'openai');
  const endpoint = baseUrl || getProviderEndpointForProtocol(provider, providerProtocol);
  if (!endpoint) return null;

  if (providerProtocol === 'claude') {
    return {
      url: `${trimTrailingSlash(endpoint)}/models`,
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'anthropic-version': API_VERSIONS.ANTHROPIC,
      },
    };
  }

  if (normalizedProvider === 'gemini') {
    return {
      url: `${trimTrailingSlash(endpoint)}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`,
      headers: {},
    };
  }

  return {
    url: `${trimTrailingSlash(endpoint)}/models`,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}

function getStringField(source: unknown, field: string): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(source: unknown, fields: string[]): number | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeDiscoveredModelId(value: string): string {
  return value.replace(/^models\//, '');
}

export function parseDiscoveredModelsResponse(payload: unknown): DiscoveredProviderModel[] {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  const seen = new Set<string>();
  const models: DiscoveredProviderModel[] = [];

  for (const item of rawModels) {
    const rawId = getStringField(item, 'id') || getStringField(item, 'name');
    if (!rawId) continue;
    const id = normalizeDiscoveredModelId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label = getStringField(item, 'displayName') || getStringField(item, 'display_name') || getStringField(item, 'label') || id;
    const capabilities = inferModelCapabilities(id);
    const maxTokens = getNumberField(item, ['max_context_length', 'context_length', 'contextWindow', 'maxTokens'])
      ?? getModelMaxOutputTokens(id);

    models.push({
      id,
      label,
      capabilities,
      maxTokens,
      supportsTool: inferSupportsTool(id, capabilities),
      supportsVision: capabilities.includes('vision'),
      supportsStreaming: true,
    });
  }

  return models;
}

type ProviderModelFamily =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'grok'
  | 'perplexity'
  | 'volcengine'
  | 'longcat'
  | 'xiaomi';

interface ProviderModelFamilySpec {
  family: ProviderModelFamily;
  providerAliases: readonly string[];
  modelMatchers: readonly RegExp[];
}

const BUILT_IN_PROVIDER_FAMILIES: Partial<Record<string, ProviderModelFamily>> = {
  claude: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
  qwen: 'qwen',
  minimax: 'minimax',
  grok: 'grok',
  perplexity: 'perplexity',
  volcengine: 'volcengine',
  longcat: 'longcat',
  xiaomi: 'xiaomi',
};

const PROVIDER_MODEL_FAMILY_SPECS: readonly ProviderModelFamilySpec[] = [
  {
    family: 'claude',
    providerAliases: ['claude', 'anthropic'],
    modelMatchers: [/^claude-/, /^anthropic\//, /\/claude-/],
  },
  {
    family: 'openai',
    providerAliases: ['openai'],
    modelMatchers: [/^openai\//, /^gpt-/, /^o[134]\b/, /^chatgpt-/],
  },
  {
    family: 'gemini',
    providerAliases: ['gemini', 'google'],
    modelMatchers: [/^gemini-/, /^google\/gemini-/],
  },
  {
    family: 'deepseek',
    providerAliases: ['deepseek'],
    modelMatchers: [/^deepseek\//, /^deepseek-/],
  },
  {
    family: 'moonshot',
    providerAliases: ['moonshot', 'kimi', 'moonshotai'],
    modelMatchers: [/^moonshotai\//, /^moonshot\//, /^moonshot-/, /^kimi-/],
  },
  {
    family: 'zhipu',
    providerAliases: ['zhipu', 'glm', 'zai'],
    modelMatchers: [/^zai-org\//, /^zhipu\//, /^glm-/, /^codegeex-/],
  },
  {
    family: 'qwen',
    providerAliases: ['qwen', 'qwq', 'qvq', 'alibaba'],
    modelMatchers: [/^qwen\//, /^alibaba\//, /^qwen/, /^qwq-/, /^qvq-/],
  },
  {
    family: 'minimax',
    providerAliases: ['minimax'],
    modelMatchers: [/^minimax\//, /^minimax-/],
  },
  {
    family: 'grok',
    providerAliases: ['grok', 'xai', 'x-ai'],
    modelMatchers: [/^xai\//, /^x-ai\//, /^grok-/],
  },
  {
    family: 'perplexity',
    providerAliases: ['perplexity', 'sonar'],
    modelMatchers: [/^perplexity\//, /^sonar/, /sonar/],
  },
  {
    family: 'volcengine',
    providerAliases: ['volcengine', 'doubao'],
    modelMatchers: [/^volcengine\//, /^doubao-/],
  },
  {
    family: 'longcat',
    providerAliases: ['longcat'],
    modelMatchers: [/^longcat\//, /^longcat-/],
  },
  {
    family: 'xiaomi',
    providerAliases: ['xiaomi', 'mimo'],
    modelMatchers: [/^xiaomi\//, /^mimo-/],
  },
];

function normalizedTokenValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function includesProviderToken(providerId: string, alias: string): boolean {
  const normalizedProviderId = normalizedTokenValue(providerId);
  const normalizedAlias = normalizedTokenValue(alias);
  return normalizedProviderId === normalizedAlias
    || normalizedProviderId.startsWith(`${normalizedAlias}-`)
    || normalizedProviderId.endsWith(`-${normalizedAlias}`)
    || normalizedProviderId.includes(`-${normalizedAlias}-`);
}

function resolveProviderModelFamily(
  provider: string,
  protocol?: ModelProviderProtocol,
): ProviderModelFamily | null {
  if (protocol === 'claude') {
    return 'claude';
  }

  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const builtInFamily = BUILT_IN_PROVIDER_FAMILIES[normalizedProvider];
  if (builtInFamily) {
    return builtInFamily;
  }

  const providerId = provider.toLowerCase();
  const spec = PROVIDER_MODEL_FAMILY_SPECS.find((candidate) =>
    candidate.providerAliases.some((alias) => includesProviderToken(providerId, alias))
  );
  return spec?.family ?? null;
}

export function filterDiscoveredModelsForProvider(
  provider: string,
  models: DiscoveredProviderModel[],
  protocol?: ModelProviderProtocol,
): DiscoveredProviderModel[] {
  const family = resolveProviderModelFamily(provider, protocol);
  if (!family) {
    return models;
  }

  const spec = PROVIDER_MODEL_FAMILY_SPECS.find((candidate) => candidate.family === family);
  if (!spec) {
    return models;
  }

  return models.filter((model) => {
    const id = model.id.toLowerCase();
    return spec.modelMatchers.some((matcher) => matcher.test(id));
  });
}

export async function handleDiscoverModels(payload: DiscoverModelsPayload): Promise<DiscoverModelsResult> {
  const apiKey = resolveConfiguredApiKey(payload.provider, payload.apiKey);
  const discovery = getDiscoveryUrl(payload.provider, payload.baseUrl, apiKey, payload.protocol);
  if (!discovery) {
    return {
      success: false,
      models: [],
      latencyMs: 0,
      error: {
        code: 'UNSUPPORTED_PROVIDER',
        message: `不支持模型发现的 Provider: ${payload.provider}`,
        suggestion: '请确认 Provider 名称和 Base URL 正确',
      },
    };
  }

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP.CONNECT_TIMEOUT);
    const response = await fetch(discovery.url, {
      method: 'GET',
      headers: discovery.headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        success: false,
        models: [],
        latencyMs,
        error: mapHttpError(response.status, errorText),
      };
    }

    const data: unknown = await response.json().catch(() => null);
    const models = parseDiscoveredModelsResponse(data);
    return {
      success: true,
      models: filterDiscoveredModelsForProvider(payload.provider, models, payload.protocol),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        success: false,
        models: [],
        latencyMs,
        error: {
          code: 'TIMEOUT',
          message: `发现模型超时 (${MCP.CONNECT_TIMEOUT / 1000}s)`,
          suggestion: '请检查 Base URL、网络和代理设置',
        },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      models: [],
      latencyMs,
      error: {
        code: 'NETWORK_ERROR',
        message: `发现模型失败: ${message.substring(0, 150)}`,
        suggestion: '请检查 Base URL 是否指向所选协议的模型 API 端点',
      },
    };
  }
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Provider 相关 IPC handlers
 */
export function registerProviderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.PROVIDER, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'test_connection': {
          const data = await handleTestConnection(payload as TestConnectionPayload);
          return { success: true, data };
        }
        case 'discover_models': {
          const data = await handleDiscoverModels(payload as DiscoverModelsPayload);
          return { success: true, data };
        }
        case 'run_diagnostics': {
          const data = await runDiagnostics();
          return { success: true, data };
        }
        case 'run_doctor': {
          const data = await runDoctor(payload as RunDoctorOptions | undefined);
          return { success: true, data };
        }
        case 'getHealthStatus': {
          const monitor = getProviderHealthMonitor();
          const healthMap = monitor.getHealthMap();
          const data: Record<string, { status: string; latencyP50: number; errorRate: number }> = {};
          for (const [name, health] of healthMap) {
            data[name] = { status: health.status, latencyP50: health.latencyP50, errorRate: health.errorRate };
          }
          return { success: true, data };
        }
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
