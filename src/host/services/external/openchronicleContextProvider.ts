// ============================================================================
// OpenchronicleContextProvider — fetch current_context() from OC's MCP server
// and format it as a short system-prompt block.
//
// Called at session start in conversationRuntime. Cheap when toggle is OFF
// (returns null without I/O); otherwise one HTTP POST to localhost:8742.
// ============================================================================

import { createLogger } from '../infra/logger';
import { loadSettings } from './openchronicleSupervisor';
import { compileFilter, filterCaptures, type CompiledFilter } from './openchronicleContextFilter';
import { OPENCHRONICLE_MCP_ENDPOINT } from '../../../shared/contract/openchronicle';

const logger = createLogger('OpenchronicleContextProvider');

const FETCH_TIMEOUT_MS = 3000;
const MAX_INJECTED_CHARS = 2000;
const STATELESS_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'code-agent-screen-memory', version: '1' } as const;
const protocolModes = new Map<string, 'legacy'>();

interface CaptureHeadline {
  time?: string;
  app_name?: string;
  window_title?: string;
  focused_role?: string;
  file_stem?: string;
}

interface CaptureFulltext {
  time?: string;
  app_name?: string;
  window_title?: string;
  visible_text?: string;
  focused_value?: string;
  url?: string;
}

interface TimelineBlock {
  start_time?: string;
  end_time?: string;
  // Each entry is a single line like "[Codex] user is continuing work on …"
  entries?: string[];
  // Backing fields (some OC versions emit these too — kept for forward compat)
  app_name?: string;
  summary?: string;
}

interface CurrentContextResult {
  recent_captures_headline?: CaptureHeadline[];
  recent_captures_fulltext?: CaptureFulltext[];
  recent_timeline_blocks?: TimelineBlock[];
}

// ---------------------------------------------------------------------------
// MCP client: minimal JSON-RPC POST against streamable-http transport
// ---------------------------------------------------------------------------

function parseSseOrJson(text: string): unknown {
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  return JSON.parse(payload);
}

interface JsonRpcError {
  code?: number;
  data?: unknown;
}

interface JsonRpcResponse {
  result?: {
    resultType?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    [key: string]: unknown;
  };
  error?: JsonRpcError;
}

type ToolAttempt =
  | { kind: 'success'; value: unknown }
  | { kind: 'unsupported' }
  | { kind: 'failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsupportedProtocolError(error: JsonRpcError): boolean {
  if (error.code === -32601) return true;
  if (!isRecord(error.data)) return false;
  const reason = error.data.reason ?? error.data.code ?? error.data.kind;
  return reason === 'unsupported_protocol_version'
    || reason === 'unsupportedProtocolVersion'
    || Array.isArray(error.data.supportedProtocolVersions);
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initializeMcpSession(signal: AbortSignal): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(OPENCHRONICLE_MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      }),
      signal,
    });
  } catch (error) {
    logger.warn('OpenChronicle legacy initialize network failure', { error: errorDetails(error) });
    return null;
  }
  if (!res.ok) {
    logger.warn('OpenChronicle legacy initialize HTTP failure', { status: res.status });
    return null;
  }

  const sessionId = res.headers.get('mcp-session-id');
  if (sessionId) return sessionId;

  try {
    const parsed = parseSseOrJson(await res.text()) as JsonRpcResponse;
    if (parsed.error) {
      logger.warn('OpenChronicle legacy initialize JSON-RPC error', {
        code: parsed.error.code,
        data: parsed.error.data,
      });
    } else {
      logger.warn('OpenChronicle legacy initialize returned no mcp-session-id');
    }
  } catch (error) {
    logger.warn('OpenChronicle legacy initialize response was unparseable and had no mcp-session-id', {
      error: errorDetails(error),
    });
  }
  return null;
}

async function performToolCall(
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  mode: 'stateless' | 'legacy',
  sessionId?: string,
): Promise<ToolAttempt> {
  let res: Response;
  try {
    res = await fetch(OPENCHRONICLE_MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
          ...(mode === 'stateless'
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': STATELESS_PROTOCOL_VERSION,
                  'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
                },
              }
            : {}),
        },
      }),
      signal,
    });
  } catch (error) {
    logger.warn(`OpenChronicle ${mode} tools/call network failure`, { error: errorDetails(error) });
    return { kind: 'failed' };
  }

  if (!res.ok) {
    logger.warn(`OpenChronicle ${mode} tools/call HTTP failure`, { status: res.status });
    if (mode === 'stateless' && res.status >= 400 && res.status < 500) {
      return { kind: 'unsupported' };
    }
    return { kind: 'failed' };
  }

  let parsed: JsonRpcResponse;
  try {
    parsed = parseSseOrJson(await res.text()) as JsonRpcResponse;
  } catch (error) {
    logger.warn(`OpenChronicle ${mode} tools/call response was unparseable`, {
      error: errorDetails(error),
    });
    return { kind: 'failed' };
  }

  if (parsed.error) {
    logger.warn(`OpenChronicle ${mode} tools/call JSON-RPC error`, {
      code: parsed.error.code,
      data: parsed.error.data,
    });
    if (mode === 'stateless' && isUnsupportedProtocolError(parsed.error)) {
      return { kind: 'unsupported' };
    }
    return { kind: 'failed' };
  }

  const resultType = parsed.result?.resultType ?? 'complete';
  if (resultType === 'input_required') {
    logger.warn(`OpenChronicle ${mode} tools/call requires additional input`, { toolName });
    return { kind: 'failed' };
  }
  if (resultType !== 'complete') {
    logger.warn(`OpenChronicle ${mode} tools/call returned an unknown resultType`, {
      resultType,
      toolName,
    });
    return { kind: 'failed' };
  }

  const first = parsed.result?.content?.[0];
  if (first?.type === 'text' && typeof first.text === 'string') {
    try {
      return { kind: 'success', value: JSON.parse(first.text) };
    } catch {
      return { kind: 'success', value: first.text };
    }
  }
  if (parsed.result !== undefined) {
    return { kind: 'success', value: parsed.result };
  }
  logger.warn(`OpenChronicle ${mode} tools/call response contained no result`, { toolName });
  return { kind: 'failed' };
}

async function callMcpTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const cachedLegacy = protocolModes.get(OPENCHRONICLE_MCP_ENDPOINT) === 'legacy';
    if (!cachedLegacy) {
      const stateless = await performToolCall(toolName, args, ctrl.signal, 'stateless');
      if (stateless.kind === 'success') return stateless.value;
      if (stateless.kind === 'failed') return null;
      logger.warn('OpenChronicle stateless tools/call unsupported; falling back to legacy initialize');
    }

    const sessionId = await initializeMcpSession(ctrl.signal);
    if (!sessionId) {
      logger.warn(cachedLegacy
        ? 'OpenChronicle cached legacy MCP path failed during initialize'
        : 'OpenChronicle stateless and legacy MCP paths both failed');
      return null;
    }

    const legacy = await performToolCall(toolName, args, ctrl.signal, 'legacy', sessionId);
    if (legacy.kind === 'success') {
      protocolModes.set(OPENCHRONICLE_MCP_ENDPOINT, 'legacy');
      return legacy.value;
    }
    logger.warn(cachedLegacy
      ? 'OpenChronicle cached legacy MCP path failed during tools/call'
      : 'OpenChronicle stateless and legacy MCP paths both failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Formatter — turn current_context() JSON into a short, LLM-readable block
// ---------------------------------------------------------------------------

function formatTime(iso?: string): string {
  if (!iso) return '';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m?.[1] ?? '';
}

function formatHeadlines(headlines: CaptureHeadline[]): string[] {
  return headlines
    .slice(0, 5)
    .map((h) => {
      const t = formatTime(h.time);
      const app = h.app_name ?? '?';
      const title = (h.window_title ?? '').slice(0, 60);
      return `- ${t} [${app}] ${title}`.trim();
    })
    .filter((line) => line.length > 8);
}

function formatTimeline(blocks: TimelineBlock[]): string[] {
  return blocks
    .slice(-5)
    .map((b) => {
      const start = formatTime(b.start_time);
      const end = formatTime(b.end_time);
      // OC emits entries as strings already prefixed with "[App] ..."
      const firstEntry = b.entries?.[0] ?? b.summary ?? '';
      return `[${start}-${end}] ${firstEntry}`.slice(0, 200).trim();
    })
    .filter((line) => line.length > 8);
}

function formatContext(payload: CurrentContextResult, filter: CompiledFilter): string {
  const sections: string[] = [];

  const headlines = filterCaptures(payload.recent_captures_headline, filter);
  if (headlines.length > 0) {
    sections.push('最近活动:\n' + formatHeadlines(headlines).join('\n'));
  }

  const blocks = filterCaptures(payload.recent_timeline_blocks, filter);
  if (blocks.length > 0) {
    sections.push('近期时间线:\n' + formatTimeline(blocks).join('\n'));
  }

  let text = sections.join('\n\n');
  if (text.length > MAX_INJECTED_CHARS) {
    text = text.slice(0, MAX_INJECTED_CHARS) + '\n…(已截断)';
  }
  return text;
}

// ---------------------------------------------------------------------------
// Public — called from conversationRuntime at session start
// ---------------------------------------------------------------------------

/**
 * Fetch and format OpenChronicle's current_context, or return null when:
 * - the toggle is OFF
 * - autoInjectContext is OFF
 * - the daemon is unreachable
 * - the response is empty / unparseable
 *
 * Never throws — failures are logged before graceful degradation.
 */
export async function fetchOpenchronicleContext(): Promise<string | null> {
  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    logger.warn('OpenChronicle settings could not be loaded', { error: errorDetails(error) });
    return null;
  }
  if (!settings.enabled || !settings.autoInjectContext) return null;

  const result = await callMcpTool('current_context', {
    headline_limit: 5,
    fulltext_limit: 2,
    timeline_limit: 5,
  });
  if (!result || typeof result !== 'object') {
    logger.warn('OpenChronicle current_context returned no object payload');
    return null;
  }

  const filter = compileFilter(settings);
  const formatted = formatContext(result as CurrentContextResult, filter);
  if (!formatted.trim()) {
    logger.warn('OpenChronicle current_context payload contained no usable context');
    return null;
  }
  return formatted;
}
