import {
  API_VERSIONS,
  getProviderEndpointForProtocol,
  normalizeProviderId,
  MCP,
} from '../../shared/constants';
import type { ModelProvider, ModelProviderProtocol } from '../../shared/contract';
import { getConfigService } from '../services/core/configService';

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

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveConfiguredApiKey(provider: string, apiKey?: string): string {
  const trimmed = apiKey?.trim();
  if (trimmed) return trimmed;
  try {
    return getConfigService().getApiKey(provider as ModelProvider) ?? '';
  } catch {
    return '';
  }
}

function buildTestConfig(
  provider: string,
  apiKey: string,
  baseUrl?: string,
  protocol?: ModelProviderProtocol,
  model?: string,
): { url: string; method: string; headers: Record<string, string>; body?: string } | null {
  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const providerProtocol = protocol ?? (normalizedProvider === 'claude' ? 'claude' : 'openai');
  const endpoint = baseUrl || getProviderEndpointForProtocol(provider, providerProtocol);
  if (!endpoint) return null;

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

  if (normalizedProvider === 'gemini') {
    return {
      url: `${endpoint}/models?key=${apiKey}`,
      method: 'GET',
      headers: {},
    };
  }

  return {
    url: `${endpoint}/models`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

export function mapProviderHttpError(status: number, body: string): TestConnectionResult['error'] {
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
  const apiKey = resolveConfiguredApiKey(payload.provider, payload.apiKey);
  const config = buildTestConfig(payload.provider, apiKey, payload.baseUrl, payload.protocol, payload.model);

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
      error: mapProviderHttpError(response.status, errorText),
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
