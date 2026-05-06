// ============================================================================
// HTTP Transport - 通过 HTTP API 与后端通信
// ============================================================================
//
// 在浏览器或 Tauri WebView 中运行时，将 codeAgentAPI/codeAgentDomainAPI 的调用
// 转发到 HTTP API 端点。使用 EventSource (SSE) 处理流式事件。
//
// ============================================================================

import type {
  ElectronAPI as CommandBridgeAPI,
  DomainAPI,
  IPCResponse,
  IpcInvokeHandlers,
  IpcEventHandlers,
} from '../../shared/ipc';
import { getLocalBridgeClient } from '../services/localBridge';
import { useLocalBridgeStore } from '../stores/localBridgeStore';

type EventCallback = (...args: unknown[]) => void;

const AUTH_RELOAD_ATTEMPT_KEY = 'code-agent:http-auth-token-reload-attempted';

type AuthTokenRecovery = {
  status: number;
  message: string;
  willReload: boolean;
};

function getInjectedAuthToken(): string | undefined {
  return (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined;
}

function getReloadStorage(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function clearAuthTokenReloadAttempt(): void {
  getReloadStorage()?.removeItem(AUTH_RELOAD_ATTEMPT_KEY);
}

function scheduleAuthTokenReloadOnce(): boolean {
  const storage = getReloadStorage();
  if (storage?.getItem(AUTH_RELOAD_ATTEMPT_KEY) === '1') {
    return false;
  }
  storage?.setItem(AUTH_RELOAD_ATTEMPT_KEY, '1');

  const reload = window.location?.reload;
  if (typeof reload !== 'function') {
    return false;
  }

  window.setTimeout(() => {
    window.location.reload();
  }, 250);
  return true;
}

function parseHttpErrorMessage(errorBody: string): string {
  if (!errorBody) return '';
  try {
    const parsed = JSON.parse(errorBody) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.error === 'string') return record.error;
      if (record.error && typeof record.error === 'object') {
        const error = record.error as Record<string, unknown>;
        if (typeof error.message === 'string') return error.message;
        if (typeof error.code === 'string') return error.code;
      }
      if (typeof record.message === 'string') return record.message;
    }
  } catch {
    // fall through to raw body
  }
  return errorBody;
}

function getRecoverableAuthTokenError(status: number, errorMessage: string): AuthTokenRecovery | null {
  if (status !== 401 && status !== 403) return null;
  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes('auth token') && !normalized.includes('authorization')) {
    return null;
  }

  const willReload = scheduleAuthTokenReloadOnce();
  const nextStep = willReload
    ? '页面会自动刷新一次，重新注入本地 token。'
    : '请手动刷新页面，重新注入本地 token。';
  return {
    status,
    willReload,
    message: `本地 Web 会话 token 已失效 (${status}: ${errorMessage || 'Invalid auth token'})。${nextStep}问题在本地页面和后端 token 不一致，和模型或云端代理无关。`,
  };
}

/**
 * 基于 HTTP API 的 Code Agent API polyfill
 *
 * 将 IPC invoke 调用映射到 REST API 端点，
 * 将 IPC on/off 事件映射到 SSE EventSource。
 */
/**
 * 处理 tool_call_local 事件：调用本地 Bridge 执行工具，将结果 POST 回 webServer
 */
async function handleLocalToolCall(baseUrl: string, data: Record<string, unknown>): Promise<void> {
  const bridgeStore = useLocalBridgeStore.getState();
  if (bridgeStore.status !== 'connected') {
    console.warn('[HttpTransport] Bridge not connected, cannot execute local tool:', data.tool);
    // POST error result back
    await fetch(`${baseUrl}/api/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        toolCallId: data.toolCallId,
        success: false,
        error: 'Local Bridge is not connected. Please start the Bridge service on localhost:9527.',
      }),
    });
    return;
  }

  try {
    const client = getLocalBridgeClient();
    const result = await client.invokeTool(
      data.tool as string,
      data.params as Record<string, unknown>
    );

    // POST result back to webServer
    await fetch(`${baseUrl}/api/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        toolCallId: data.toolCallId,
        success: result.success,
        output: result.output,
        error: result.error,
        metadata: result.metadata,
      }),
    });
  } catch (err) {
    console.error('[HttpTransport] Local tool execution failed:', err);
    await fetch(`${baseUrl}/api/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        toolCallId: data.toolCallId,
        success: false,
        error: `Bridge invocation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }),
    });
  }
}

/** Get auth headers for API requests. Token is injected into HTML by webServer. */
function getAuthHeaders(): Record<string, string> {
  const token = getInjectedAuthToken();
  if (token) {
    return { 'Authorization': `Bearer ${token}` };
  }
  return {};
}

export function createHttpCodeAgentAPI(baseUrl: string): CommandBridgeAPI {
  // 事件监听器管理
  const listeners = new Map<string, Set<EventCallback>>();
  let eventSource: EventSource | null = null;
  let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // ADR-010 #6: 跟踪 backend 分配的单调 event id；重连时作为 lastEventId 传回，
  // 让服务端 replay buffer 补发断线窗口内错过的事件。
  let lastSeenEventId = -1;

  /**
   * 初始化 SSE 连接，接收后端推送事件
   */
  function ensureSSE(): void {
    if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;

    const token = getInjectedAuthToken();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (lastSeenEventId >= 0) params.set('lastEventId', String(lastSeenEventId));
    const query = params.toString();
    const sseUrl = query ? `${baseUrl}/api/events?${query}` : `${baseUrl}/api/events`;
    eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      // EventSource 从 `id:` 行解析出的 lastEventId 是字符串。broadcastSSE 用单调
      // 递增的整数写入，这里解析并只在递增时更新，防止乱序事件回退游标。
      const incomingId = Number.parseInt(event.lastEventId ?? '', 10);
      if (Number.isFinite(incomingId) && incomingId > lastSeenEventId) {
        lastSeenEventId = incomingId;
      }
      try {
        const parsed = JSON.parse(event.data);
        const { channel, args } = parsed;
        const cbs = listeners.get(channel);
        if (cbs) {
          cbs.forEach((cb) => cb(...(Array.isArray(args) ? args : [args])));
        }
      } catch {
        // 忽略解析失败的事件
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      // 自动重连（5s 后）
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
      sseRetryTimer = setTimeout(() => {
        if (listeners.size > 0) ensureSSE();
      }, 5000);
    };
  }

  /**
   * 将 IPC channel 映射到 HTTP 端点
   * channel 格式: "domain:action" -> "/api/domain/action"
   */
  function channelToEndpoint(channel: string): { method: string; path: string } {
    // 特殊映射表（需要特殊处理的 channel）
    const specialRoutes: Record<string, { method: string; path: string }> = {
      'agent:send-message': { method: 'POST', path: '/api/run' },
      'agent:cancel': { method: 'POST', path: '/api/cancel' },
      'settings:get': { method: 'GET', path: '/api/settings' },
      'settings:set': { method: 'PUT', path: '/api/settings' },
      'session:list': { method: 'GET', path: '/api/sessions' },
      'session:create': { method: 'POST', path: '/api/sessions' },
      'session:load': { method: 'GET', path: '/api/sessions/:id' },
      'session:delete': { method: 'DELETE', path: '/api/sessions/:id' },
      'session:get-messages': { method: 'GET', path: '/api/sessions/:id/messages' },
      'session:archive': { method: 'POST', path: '/api/sessions/:id/archive' },
      'session:unarchive': { method: 'POST', path: '/api/sessions/:id/unarchive' },
    };

    if (specialRoutes[channel]) {
      return specialRoutes[channel];
    }

    // 通用映射: "domain:action" -> GET /api/domain/action
    const parts = channel.split(':');
    const path = `/api/${parts.join('/')}`;
    return { method: 'POST', path };
  }

  const api: CommandBridgeAPI = {
    invoke: (async <K extends keyof IpcInvokeHandlers>(
      channel: K & string,
      ...args: Parameters<IpcInvokeHandlers[K]>
    ): Promise<ReturnType<IpcInvokeHandlers[K]>> => {
      const { method, path } = channelToEndpoint(channel);

      // 替换路径参数（如 :id）
      let finalPath = path;
      let bodyArgs = [...args];

      if (path.includes(':id') && args.length > 0) {
        finalPath = path.replace(':id', String(args[0]));
        bodyArgs = args.slice(1) as typeof bodyArgs;
      }

      // agent:send-message 特殊处理 — SSE 流式响应
      if (channel === 'agent:send-message') {
        const arg = args[0] as Record<string, unknown> | string;
        const prompt = typeof arg === 'string' ? arg : (arg as { content: string }).content;
        const sessionId = typeof arg === 'object' && arg !== null ? (arg as { sessionId?: string }).sessionId : undefined;
        const attachments = typeof arg === 'object' && arg !== null ? (arg as { attachments?: unknown[] }).attachments : undefined;
        const options = typeof arg === 'object' && arg !== null ? (arg as { options?: unknown }).options : undefined;
        const context = typeof arg === 'object' && arg !== null ? (arg as { context?: unknown }).context : undefined;
        const response = await fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            prompt,
            ...(sessionId ? { sessionId } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(options ? { options } : {}),
            ...(context ? { context } : {}),
          }),
        });

        // 非 2xx 响应：读取错误体并抛出，避免当 SSE 流解析
        if (!response.ok) {
          const errorBody = await response.text();
          const errorMessage = parseHttpErrorMessage(errorBody);
          const authError = getRecoverableAuthTokenError(response.status, errorMessage);
          if (authError) {
            console.warn('[HttpTransport] local auth token expired:', authError.message);
            throw new Error(authError.message);
          }
          throw new Error(`云端代理请求失败 (${response.status}): ${errorMessage}`);
        }
        clearAuthTokenReloadAttempt();

        // 读取 SSE 流并分发事件到 listeners
      if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let streamSessionId = sessionId;

          const processStream = async () => {
            let currentEvent = '';  // 移到 while 外面，防止跨 chunk 时 event/data 分属不同 read() 导致丢失
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  // 流结束前处理 buffer 中残留的数据（最后一行可能没有尾部换行）
                  if (buffer.trim()) {
                    const remainingLines = buffer.split('\n');
                    for (const line of remainingLines) {
                      if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim();
                      } else if (line.startsWith('data: ') && currentEvent) {
                        try {
                          const data = JSON.parse(line.slice(6));
                          const currentSessionId = data?.sessionId;
                          if (currentSessionId) streamSessionId = currentSessionId;
                          const cbs = listeners.get('agent:event');
                          if (cbs) {
                            cbs.forEach((cb) => cb({ type: currentEvent, data, sessionId: currentSessionId }));
                          }
                        } catch { /* ignore */ }
                        currentEvent = '';
                      }
                    }
                  }
                  // 流结束兜底：确保 agent_complete 被派发（防止后端异常退出时状态卡住）
                  const completeCbs = listeners.get('agent:event');
                  if (completeCbs) {
                    completeCbs.forEach((cb) => cb({
                      type: 'stream_end',
                      data: streamSessionId ? { sessionId: streamSessionId } : {},
                      sessionId: streamSessionId,
                    }));
                  }
                  break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                  if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                  } else if (line.startsWith('data: ') && currentEvent) {
                    try {
                      const data = JSON.parse(line.slice(6));
                      const currentSessionId = data?.sessionId;
                      if (currentSessionId) streamSessionId = currentSessionId;

                      // ── Local Bridge 拦截: tool_call_local 事件 ──
                      if (currentEvent === 'tool_call_local') {
                        console.debug('[HttpTransport] Intercepted tool_call_local:', data.tool, data.toolCallId);
                        handleLocalToolCall(baseUrl, data).catch((err) => {
                          console.error('[HttpTransport] handleLocalToolCall error:', err);
                        });
                        // 仍然派发事件给 UI（用于显示工具执行状态）
                      }

                      // 将 SSE 事件转发到 agent:event listeners
                      const cbs = listeners.get('agent:event');
                      if (currentEvent !== 'stream_chunk') {
                        console.debug('[HttpTransport] Dispatching SSE event:', currentEvent, currentSessionId ? `(session: ${currentSessionId})` : '');
                      }
                      if (cbs) {
                        cbs.forEach((cb) => cb({ type: currentEvent, data, sessionId: currentSessionId }));
                      }
                    } catch {
                      // 忽略解析错误
                    }
                    currentEvent = '';
                  }
                }
              }
            } catch (err) {
              console.error('[HttpTransport] processStream error:', err);
              const errorCbs = listeners.get('agent:event');
              if (errorCbs) {
                errorCbs.forEach((cb) => cb({
                  type: 'error',
                  data: { message: err instanceof Error ? err.message : 'Stream error' },
                  sessionId: streamSessionId,
                }));
              }
            }
          };

          // 不 await，让流在后台处理，但记录未捕获错误
          processStream().catch((err) => {
            console.error('[HttpTransport] Unhandled processStream error:', err);
          });
        }

        return undefined as ReturnType<IpcInvokeHandlers[K]>;
      }

      // 通用 HTTP 调用
      const fetchOptions: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      };

      if (method !== 'GET' && method !== 'HEAD' && bodyArgs.length > 0) {
        let bodyPayload: unknown = bodyArgs.length === 1 ? bodyArgs[0] : bodyArgs;
        // session:create 传入的是字符串 title，后端期望 {title} 对象
        if (channel === 'session:create' && typeof bodyPayload === 'string') {
          bodyPayload = { title: bodyPayload };
        }
        fetchOptions.body = JSON.stringify(bodyPayload);
      } else if (method === 'GET' && bodyArgs.length > 0 && typeof bodyArgs[0] === 'object') {
        // GET 请求参数放到 query string
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(bodyArgs[0] as Record<string, unknown>)) {
          if (v !== undefined) params.set(k, String(v));
        }
        const qs = params.toString();
        if (qs) finalPath += `?${qs}`;
      }

      try {
        const response = await fetch(`${baseUrl}${finalPath}`, fetchOptions);

        if (!response.ok) {
          const errorBody = await response.text();
          const errorMessage = parseHttpErrorMessage(errorBody);
          const authError = getRecoverableAuthTokenError(response.status, errorMessage);
          if (authError) {
            console.warn(`[HttpTransport] ${channel} local auth token expired:`, authError.message);
            throw new Error(authError.message);
          }
          console.warn(`[HttpTransport] ${channel} failed:`, response.status, errorMessage || errorBody);
          return undefined as ReturnType<IpcInvokeHandlers[K]>;
        }
        clearAuthTokenReloadAttempt();

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const json = await response.json();
          // 解包 IPCResponse 格式: webServer 返回 {success, data} 包装体
          // 前端 store 期望的是裸数据（Session[], AppSettings 等）
          if (json && typeof json === 'object' && 'success' in json) {
            if (json.success === false) {
              // 错误响应（如 NOT_FOUND）不应作为有效数据透传到前端
              console.warn(`[HttpTransport] ${channel} returned error:`, json.error);
              return undefined as ReturnType<IpcInvokeHandlers[K]>;
            }
            if ('data' in json) {
              return json.data as ReturnType<IpcInvokeHandlers[K]>;
            }
          }
          return json as ReturnType<IpcInvokeHandlers[K]>;
        }

        return undefined as ReturnType<IpcInvokeHandlers[K]>;
      } catch (err) {
        console.warn(`[HttpTransport] ${channel} error:`, err);
        return undefined as ReturnType<IpcInvokeHandlers[K]>;
      }
    }) as CommandBridgeAPI['invoke'],

    on: (<K extends keyof IpcEventHandlers>(
      channel: K & string,
      callback: IpcEventHandlers[K]
    ): (() => void) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
      }
      listeners.get(channel)!.add(callback as EventCallback);

      // 有监听器时确保 SSE 连接存在
      ensureSSE();

      // 返回取消订阅函数
      return () => {
        const set = listeners.get(channel);
        if (set) {
          set.delete(callback as EventCallback);
          if (set.size === 0) listeners.delete(channel);
        }

        // 所有监听器都移除后关闭 SSE
        if (listeners.size === 0) {
          eventSource?.close();
          eventSource = null;
        }
      };
    }) as CommandBridgeAPI['on'],

    off: (<K extends keyof IpcEventHandlers>(
      channel: K & string,
      callback: IpcEventHandlers[K]
    ): void => {
      const set = listeners.get(channel);
      if (set) {
        set.delete(callback as EventCallback);
        if (set.size === 0) listeners.delete(channel);
      }
    }) as CommandBridgeAPI['off'],

    getPathForFile: async (_file: File) => {
      const formData = new FormData();
      formData.append('file', _file);

      const relativePath = (_file as File & { relativePath?: string }).relativePath;
      if (relativePath) {
        formData.append('relativePath', relativePath);
      }

      const res = await fetch(`${baseUrl}/api/upload/temp`, {
        method: 'POST',
        headers: { ...getAuthHeaders() },
        body: formData,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        const errorMessage = parseHttpErrorMessage(errorBody);
        const authError = getRecoverableAuthTokenError(res.status, errorMessage);
        if (authError) {
          throw new Error(authError.message);
        }
        throw new Error(`Upload failed: ${res.status}`);
      }

      const json = await res.json() as { path?: string; data?: { path?: string } };
      const uploadedPath = json.path ?? json.data?.path;
      if (!uploadedPath) {
        throw new Error('Upload response missing path');
      }

      return uploadedPath;
    },

    extractPdfText: async (_filePath: string) => {
      try {
        const res = await fetch(`${baseUrl}/api/extract/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ filePath: _filePath }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json();
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return { text: '', pageCount: 0 };
    },

    extractExcelText: async (_filePath: string) => {
      try {
        const res = await fetch(`${baseUrl}/api/extract/excel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ filePath: _filePath }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json();
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return { text: '', sheetCount: 0, rowCount: 0 };
    },

    extractExcelJson: async (_filePath: string) => {
      try {
        const res = await fetch(`${baseUrl}/api/extract/excel-json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ filePath: _filePath }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json();
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return null;
    },

    extractDocxHtml: async (_filePath: string) => {
      try {
        const res = await fetch(`${baseUrl}/api/extract/docx-html`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ filePath: _filePath }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json();
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return null;
    },

    transcribeSpeech: async (_audioData: string, _mimeType: string) => {
      try {
        const res = await fetch(`${baseUrl}/api/speech/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ audioData: _audioData, mimeType: _mimeType }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json();
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return { success: false, error: 'HTTP transport: transcribe not available' };
    },
  };

  return api;
}

/**
 * @deprecated Compatibility alias for older imports and tests.
 */
export const createHttpElectronAPI = createHttpCodeAgentAPI;

/**
 * 基于 HTTP API 的 DomainAPI polyfill
 */
export function createHttpDomainAPI(baseUrl: string): DomainAPI {
  return {
    invoke: async <T = unknown>(
      domain: string,
      action: string,
      payload?: unknown
    ): Promise<IPCResponse<T>> => {
      // domain 可能带 'domain:' 前缀，统一去除
      const cleanDomain = domain.replace(/^domain:/, '');

      try {
        const res = await fetch(`${baseUrl}/api/domain/${cleanDomain}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            action,
            payload,
            requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          }),
        });

        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return await res.json() as IPCResponse<T>;
        }

        const errorMessage = parseHttpErrorMessage(await res.text());
        const authError = getRecoverableAuthTokenError(res.status, errorMessage);
        if (authError) {
          return {
            success: false,
            error: {
              code: 'LOCAL_AUTH_TOKEN_EXPIRED',
              message: authError.message,
            },
          };
        }

        return {
          success: false,
          error: {
            code: `HTTP_${res.status}`,
            message: errorMessage,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'NETWORK_ERROR',
            message: err instanceof Error ? err.message : 'Network error',
          },
        };
      }
    },
  };
}
