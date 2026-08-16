// ============================================================================
// TraceLedgerClient —— 会话账本（turn trace）只读客户端
// ----------------------------------------------------------------------------
// P0B 读服务的 renderer 侧消费口：全部数据走三个 trace 路由
//   GET  /api/sessions/:id/trace          整读
//   GET  /api/sessions/:id/trace/tail     游标增量
//   POST /api/sessions/traces/summary     批量摘要
// 前端纯投影，不建第二份数据。事件包络刻意保持开放（与 host 读服务同一策略）：
// 写方可能先于本进程升级加事件类型，检查器要原样投影而不是解码失败。
// 任何失败（无 webServer / 鉴权 / 网络）一律返回 null，由 UI 走「无账本」空态，
// 绝不臆造账本内容。
// ============================================================================

export type TraceLedgerState = 'missing' | 'empty' | 'present';

export interface TraceLedgerEvent {
  ts?: unknown;
  sessionId?: unknown;
  turnIndex?: unknown;
  type?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface TraceSessionRead {
  sessionId: string;
  state: TraceLedgerState;
  events: TraceLedgerEvent[];
  skippedLines: number;
  cursor: number;
}

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  return typeof token === 'string' && token ? { Authorization: `Bearer ${token}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRead(value: unknown, sessionId: string): TraceSessionRead | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (state !== 'missing' && state !== 'empty' && state !== 'present') return null;
  return {
    sessionId,
    state,
    events: Array.isArray(value.events) ? (value.events as TraceLedgerEvent[]) : [],
    skippedLines: typeof value.skippedLines === 'number' ? value.skippedLines : 0,
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
  };
}

async function getJson(path: string): Promise<unknown | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const response = await fetch(path, { headers: { ...getAuthHeaders() } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || body.success !== true) return null;
    return body.data;
  } catch {
    return null;
  }
}

/** 整读一个会话的账本。会话不存在 / 服务不可用 / 读失败都返回 null。 */
export async function fetchSessionTrace(sessionId: string): Promise<TraceSessionRead | null> {
  if (!sessionId) return null;
  const data = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/trace`);
  return data === null ? null : normalizeRead(data, sessionId);
}

/** 从字节游标增量 tail。cursor 复用 P0B 口径（文件字节偏移）。 */
export async function tailSessionTrace(
  sessionId: string,
  cursor: number,
): Promise<TraceSessionRead | null> {
  if (!sessionId) return null;
  const data = await getJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/trace/tail?cursor=${Math.max(0, Math.floor(cursor))}`,
  );
  return data === null ? null : normalizeRead(data, sessionId);
}
