// ============================================================================
// Provider IPC Handlers - provider:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  API_VERSIONS,
  getProviderInfo,
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

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface TestConnectionPayload {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  protocol?: ModelProviderProtocol;
}

export interface TestConnectionResult {
  success: boolean;
  latencyMs: number;
  error?: {
    code: string;
    message: string;
    suggestion: string;
  };
}

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

/**
 * 构建测试请求配置
 * 大部分 provider 兼容 OpenAI /models GET 接口，特殊 provider 单独处理
 */
function buildTestConfig(
  provider: string,
  apiKey: string,
  baseUrl?: string,
  protocol?: ModelProviderProtocol,
  model?: string,
): { url: string; method: string; headers: Record<string, string>; body?: string } | null {
  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const providerProtocol = protocol ?? (normalizedProvider === 'claude' ? 'claude' : 'openai');
  const registry = getProviderInfo(provider);
  const endpoint = baseUrl || registry?.endpoint;
  if (!endpoint) return null;

  // Anthropic Claude — 不兼容 OpenAI，用 /messages 最小请求
  if (providerProtocol === 'claude') {
    return {
      url: `${trimTrailingSlash(endpoint)}/messages`,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSIONS.ANTHROPIC,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    };
  }

  // Google Gemini — REST API 格式不同
  if (normalizedProvider === 'gemini') {
    return {
      url: `${endpoint}/models?key=${apiKey}`,
      method: 'GET',
      headers: {},
    };
  }

  // OpenAI-compatible providers — GET /models
  return {
    url: `${endpoint}/models`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getDiscoveryUrl(
  provider: string,
  baseUrl?: string,
  apiKey?: string,
  protocol?: ModelProviderProtocol,
): { url: string; headers: Record<string, string> } | null {
  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const providerProtocol = protocol ?? (normalizedProvider === 'claude' ? 'claude' : 'openai');
  const registry = getProviderInfo(provider);
  const endpoint = baseUrl || registry?.endpoint;
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

/**
 * 将 HTTP 状态码映射为结构化错误
 */
function mapHttpError(status: number, body: string): TestConnectionResult['error'] {
  switch (status) {
    case 401:
      return {
        code: 'AUTH_FAILED',
        message: `认证失败 (${status})`,
        suggestion: '请检查 API Key 是否正确，注意前后不要有空格',
      };
    case 403:
      return {
        code: 'FORBIDDEN',
        message: `权限不足 (${status})`,
        suggestion: '账户可能已欠费或 API Key 权限不足，请登录对应平台检查',
      };
    case 429:
      return {
        code: 'RATE_LIMITED',
        message: `请求频率超限 (${status})`,
        suggestion: '请稍后重试，或检查账户配额',
      };
    default:
      return {
        code: 'API_ERROR',
        message: `API 错误 (${status}): ${body.substring(0, 200)}`,
        suggestion: '请检查 API 端点和 Key 配置',
      };
  }
}

export async function handleTestConnection(payload: TestConnectionPayload): Promise<TestConnectionResult> {
  const config = buildTestConfig(payload.provider, payload.apiKey, payload.baseUrl, payload.protocol, payload.model);

  if (!config) {
    return {
      success: false,
      latencyMs: 0,
      error: {
        code: 'UNSUPPORTED_PROVIDER',
        message: `不支持测试的 Provider: ${payload.provider}`,
        suggestion: '请确认 Provider 名称正确',
      },
    };
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP.CONNECT_TIMEOUT);

    const response = await fetch(config.url, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      return { success: true, latencyMs };
    }

    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      latencyMs,
      error: mapHttpError(response.status, errorText),
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        success: false,
        latencyMs,
        error: {
          code: 'TIMEOUT',
          message: `连接超时 (${MCP.CONNECT_TIMEOUT / 1000}s)`,
          suggestion: '请检查网络连接，国际 API 可能需要代理',
        },
      };
    }

    const message = err instanceof Error ? err.message : String(err);

    // 网络不可达
    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed')) {
      return {
        success: false,
        latencyMs,
        error: {
          code: 'NETWORK_ERROR',
          message: `网络错误: ${message.substring(0, 150)}`,
          suggestion: '请检查网络连接和代理设置，或确认 API 端点地址正确',
        },
      };
    }

    return {
      success: false,
      latencyMs,
      error: {
        code: 'UNKNOWN_ERROR',
        message: `连接失败: ${message.substring(0, 150)}`,
        suggestion: '请检查网络和配置后重试',
      },
    };
  }
}

export async function handleDiscoverModels(payload: DiscoverModelsPayload): Promise<DiscoverModelsResult> {
  const discovery = getDiscoveryUrl(payload.provider, payload.baseUrl, payload.apiKey, payload.protocol);
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

    const data = await response.json().catch(() => null);
    return {
      success: true,
      models: parseDiscoveredModelsResponse(data),
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
