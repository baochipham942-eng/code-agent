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
import { IPC_CHANNELS } from '../../shared/ipc';
import { RENDERER_POLLING } from '../../shared/constants';
import { getLocalBridgeClient } from '../services/localBridge';
import { useLocalBridgeStore } from '../stores/localBridgeStore';

type EventCallback = (...args: unknown[]) => void;

// 后端不可达时，前端多个 poller 会持续打到 /api 触发 catch → 每次 console.warn
// 会把控制台/日志刷爆（实测可达百万行）。按「通道 + 错误类型」节流：同一 key 在
// THROTTLE 窗口内只打一条，并在恢复时汇报期间被抑制的次数。
const lastTransportErrorLogAt = new Map<string, number>();
const suppressedTransportErrors = new Map<string, number>();

function logTransportErrorThrottled(key: string, ...args: unknown[]): void {
  const now = Date.now();
  const last = lastTransportErrorLogAt.get(key) ?? 0;
  const suppressed = suppressedTransportErrors.get(key) ?? 0;
  if (now - last < RENDERER_POLLING.TRANSPORT_ERROR_LOG_THROTTLE) {
    suppressedTransportErrors.set(key, suppressed + 1);
    return;
  }
  lastTransportErrorLogAt.set(key, now);
  if (suppressed > 0) {
    suppressedTransportErrors.set(key, 0);
    console.warn(...args, `(+${suppressed} 条同类错误已折叠)`);
  } else {
    console.warn(...args);
  }
}

const AUTH_RELOAD_ATTEMPT_KEY = 'code-agent:http-auth-token-reload-attempted';

type AuthTokenRecovery = {
  status: number;
  message: string;
  willReload: boolean;
};

type ServerSentEventPayload = {
  channel: string;
  args: unknown;
};

type WrappedHttpResponse = {
  success: boolean;
  data?: unknown;
  error?: unknown;
};

type ExtractPdfResult = Awaited<ReturnType<CommandBridgeAPI['extractPdfText']>>;
type ExtractExcelTextResult = Awaited<ReturnType<CommandBridgeAPI['extractExcelText']>>;
type ExtractExcelJsonResult = Awaited<ReturnType<CommandBridgeAPI['extractExcelJson']>>;
type ExtractDocxHtmlResult = Awaited<ReturnType<CommandBridgeAPI['extractDocxHtml']>>;
type TranscribeSpeechResult = Awaited<ReturnType<CommandBridgeAPI['transcribeSpeech']>>;

function dispatchSSEPayload(
  channel: string,
  args: unknown,
  callbacks: Set<EventCallback> | undefined,
): void {
  if (!callbacks) return;

  if (channel === IPC_CHANNELS.AGENT_EVENT_BATCH) {
    callbacks.forEach((cb) => cb(args));
    return;
  }

  const eventArgs: unknown[] = Array.isArray(args) ? args as unknown[] : [args];
  callbacks.forEach((cb) => cb(...eventArgs));
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

function parseJsonValue(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readJsonResponse(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function getStringField(data: unknown, field: string): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(data: unknown, field: string): number | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data[field];
  return typeof value === 'number' ? value : undefined;
}

function parseSSEPayload(raw: string): ServerSentEventPayload | null {
  const parsed = parseJsonValue(raw);
  if (!isRecord(parsed) || typeof parsed.channel !== 'string') {
    return null;
  }
  return {
    channel: parsed.channel,
    args: parsed.args,
  };
}

function isWrappedHttpResponse(value: unknown): value is WrappedHttpResponse {
  return isRecord(value) && typeof value.success === 'boolean';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeUnknownRows(value: unknown): unknown[][] {
  return Array.isArray(value)
    ? value.filter((row): row is unknown[] => Array.isArray(row)).map((row) => [...row])
    : [];
}

function normalizePdfResult(value: unknown): ExtractPdfResult {
  return {
    text: getStringField(value, 'text') ?? '',
    pageCount: getNumberField(value, 'pageCount') ?? 0,
  };
}

function normalizeExcelTextResult(value: unknown): ExtractExcelTextResult {
  return {
    text: getStringField(value, 'text') ?? '',
    sheetCount: getNumberField(value, 'sheetCount') ?? 0,
    rowCount: getNumberField(value, 'rowCount') ?? 0,
  };
}

function normalizeExcelJsonResult(value: unknown): ExtractExcelJsonResult {
  if (!isRecord(value) || !Array.isArray(value.sheets)) {
    return null;
  }

  const sheets = value.sheets
    .filter((sheet): sheet is Record<string, unknown> => isRecord(sheet))
    .map((sheet) => {
      const rows = normalizeUnknownRows(sheet.rows);
      return {
        name: getStringField(sheet, 'name') ?? '',
        headers: normalizeStringArray(sheet.headers),
        rows,
        rowCount: getNumberField(sheet, 'rowCount') ?? rows.length,
      };
    });

  return {
    sheets,
    sheetCount: getNumberField(value, 'sheetCount') ?? sheets.length,
  };
}

function normalizeDocxHtmlResult(value: unknown): ExtractDocxHtmlResult {
  if (!isRecord(value)) {
    return null;
  }

  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs
        .filter((paragraph): paragraph is Record<string, unknown> => isRecord(paragraph))
        .map((paragraph) => ({
          index: getNumberField(paragraph, 'index') ?? 0,
          type: getStringField(paragraph, 'type') ?? 'paragraph',
          text: getStringField(paragraph, 'text') ?? '',
          level: getNumberField(paragraph, 'level'),
        }))
    : [];

  return {
    html: getStringField(value, 'html') ?? '',
    paragraphs,
    text: getStringField(value, 'text') ?? '',
    wordCount: getNumberField(value, 'wordCount') ?? 0,
  };
}

function normalizeTranscribeResult(value: unknown): TranscribeSpeechResult {
  if (!isRecord(value)) {
    return { success: false, error: 'HTTP transport: transcribe not available' };
  }

  return {
    success: value.success === true,
    text: getStringField(value, 'text'),
    error: getStringField(value, 'error'),
    code: getStringField(value, 'code'),
    recoverable: typeof value.recoverable === 'boolean' ? value.recoverable : undefined,
    hallucination: typeof value.hallucination === 'boolean' ? value.hallucination : undefined,
    engine: getStringField(value, 'engine') as TranscribeSpeechResult['engine'],
    language: getStringField(value, 'language'),
    model: getStringField(value, 'model'),
    durationMs: getNumberField(value, 'durationMs'),
    audioPath: getStringField(value, 'audioPath'),
  };
}

function extractUploadedPath(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const directPath = getStringField(value, 'path');
  if (directPath) {
    return directPath;
  }
  return isRecord(value.data) ? getStringField(value.data, 'path') : undefined;
}

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
  const parsed = parseJsonValue(errorBody);
  if (isRecord(parsed)) {
    if (typeof parsed.error === 'string') return parsed.error;
    if (isRecord(parsed.error)) {
      if (typeof parsed.error.message === 'string') return parsed.error.message;
      if (typeof parsed.error.code === 'string') return parsed.error.code;
    }
    if (typeof parsed.message === 'string') return parsed.message;
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
      const eventData: unknown = event.data;
      if (typeof eventData !== 'string') {
        return;
      }
      const payload = parseSSEPayload(eventData);
      if (payload) {
        dispatchSSEPayload(payload.channel, payload.args, listeners.get(payload.channel));
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
        const goal = isRecord(options) && isRecord(options.goal) ? options.goal : undefined;
        const context = typeof arg === 'object' && arg !== null ? (arg as { context?: unknown }).context : undefined;
        const clientMessageId = typeof arg === 'object' && arg !== null ? (arg as { clientMessageId?: string }).clientMessageId : undefined;
        const response = await fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            prompt,
            ...(clientMessageId ? { clientMessageId } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(options ? { options } : {}),
            ...(goal ? { goal } : {}),
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
                        const data = parseJsonValue(line.slice(6));
                        if (data !== undefined) {
                          const currentSessionId = getStringField(data, 'sessionId');
                          if (currentSessionId) streamSessionId = currentSessionId;
                          const cbs = listeners.get('agent:event');
                          if (cbs) {
                            cbs.forEach((cb) => cb({
                              type: currentEvent,
                              data,
                              sessionId: currentSessionId,
                              seq: getNumberField(data, 'seq'),
                            }));
                          }
                        }
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
                    const data = parseJsonValue(line.slice(6));
                    if (data !== undefined) {
                      const currentSessionId = getStringField(data, 'sessionId');
                      if (currentSessionId) streamSessionId = currentSessionId;

                      // ── Local Bridge 拦截: tool_call_local 事件 ──
                      if (currentEvent === 'tool_call_local' && isRecord(data)) {
                        console.debug(
                          '[HttpTransport] Intercepted tool_call_local:',
                          data.tool,
                          data.toolCallId
                        );
                        handleLocalToolCall(baseUrl, data).catch((err) => {
                          console.error('[HttpTransport] handleLocalToolCall error:', err);
                        });
                        // 仍然派发事件给 UI（用于显示工具执行状态）
                      }

                      // 将 SSE 事件转发到 agent:event listeners
                      const cbs = listeners.get('agent:event');
                      if (currentEvent !== 'stream_chunk' && currentEvent !== 'message_delta') {
                        console.debug('[HttpTransport] Dispatching SSE event:', currentEvent, currentSessionId ? `(session: ${currentSessionId})` : '');
                      }
                      if (cbs) {
                        cbs.forEach((cb) => cb({
                          type: currentEvent,
                          data,
                          sessionId: currentSessionId,
                          seq: getNumberField(data, 'seq'),
                        }));
                      }
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
          logTransportErrorThrottled(
            `${channel}:${response.status}`,
            `[HttpTransport] ${channel} failed:`,
            response.status,
            errorMessage || errorBody,
          );
          return undefined as ReturnType<IpcInvokeHandlers[K]>;
        }
        clearAuthTokenReloadAttempt();

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const json = await readJsonResponse(response);
          // 解包 IPCResponse 格式: webServer 返回 {success, data} 包装体
          // 前端 store 期望的是裸数据（Session[], AppSettings 等）
          if (isWrappedHttpResponse(json)) {
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
        logTransportErrorThrottled(`${channel}:exception`, `[HttpTransport] ${channel} error:`, err);
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

      const uploadedPath = extractUploadedPath(await readJsonResponse(res));
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
          return normalizePdfResult(await readJsonResponse(res));
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
          return normalizeExcelTextResult(await readJsonResponse(res));
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
          return normalizeExcelJsonResult(await readJsonResponse(res));
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
          return normalizeDocxHtmlResult(await readJsonResponse(res));
        }
        const errorBody = await res.text();
        getRecoverableAuthTokenError(res.status, parseHttpErrorMessage(errorBody));
      } catch { /* fallthrough */ }
      return null;
    },

    transcribeSpeech: async (_audioData: string, _mimeType: string, _options) => {
      try {
        const res = await fetch(`${baseUrl}/api/speech/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ audioData: _audioData, mimeType: _mimeType, ...(_options ?? {}) }),
        });
        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return normalizeTranscribeResult(await readJsonResponse(res));
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
        const agentRuntimeEndpoint: Record<string, string> = {
          interrupt: '/api/interrupt',
          pause: '/api/pause',
          resume: '/api/resume',
        };
        const directAgentPath = cleanDomain === 'agent' ? agentRuntimeEndpoint[action] : undefined;
        const endpoint = directAgentPath
          ? `${baseUrl}${directAgentPath}`
          : `${baseUrl}/api/domain/${cleanDomain}/${action}`;
        const body = directAgentPath
          ? payload
          : {
              action,
              payload,
              requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            };

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          clearAuthTokenReloadAttempt();
          return readJsonResponse(res) as Promise<IPCResponse<T>>;
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
