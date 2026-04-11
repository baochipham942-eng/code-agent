// ============================================================================
// Provider IPC Handlers - provider:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  API_VERSIONS,
  PROVIDER_REGISTRY,
  MCP,
} from '../../shared/constants';
import type { ModelProvider } from '../../shared/types';
import { runDiagnostics } from './doctor.ipc';
import { getProviderHealthMonitor } from '../model/providerHealthMonitor';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface TestConnectionPayload {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

interface TestConnectionResult {
  success: boolean;
  latencyMs: number;
  error?: {
    code: string;
    message: string;
    suggestion: string;
  };
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
): { url: string; method: string; headers: Record<string, string>; body?: string } | null {
  const registry = PROVIDER_REGISTRY[provider as ModelProvider];
  const endpoint = baseUrl || registry?.endpoint;
  if (!endpoint) return null;

  // Anthropic Claude — 不兼容 OpenAI，用 /messages 最小请求
  if (provider === 'claude') {
    return {
      url: `${endpoint}/messages`,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSIONS.ANTHROPIC,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    };
  }

  // Google Gemini — REST API 格式不同
  if (provider === 'gemini') {
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

async function handleTestConnection(payload: TestConnectionPayload): Promise<TestConnectionResult> {
  const config = buildTestConfig(payload.provider, payload.apiKey, payload.baseUrl);

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
        case 'run_diagnostics': {
          const data = await runDiagnostics();
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
