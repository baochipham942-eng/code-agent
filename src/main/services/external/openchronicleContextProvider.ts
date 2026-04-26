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

const logger = createLogger('OpenchronicleContextProvider');

const MCP_URL = 'http://127.0.0.1:8742/mcp';
const FETCH_TIMEOUT_MS = 3000;
const MAX_INJECTED_CHARS = 2000;

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
  start?: string;
  end?: string;
  app_name?: string;
  summary?: string;
  entries?: Array<{ summary?: string; app_name?: string }>;
}

interface CurrentContextResult {
  recent_captures_headline?: CaptureHeadline[];
  recent_captures_fulltext?: CaptureFulltext[];
  recent_timeline_blocks?: TimelineBlock[];
}

// ---------------------------------------------------------------------------
// MCP client: minimal JSON-RPC POST against streamable-http transport
// ---------------------------------------------------------------------------

async function callMcpTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;

    // Streamable-http returns either JSON or SSE. Parse both.
    const text = await res.text();
    const jsonLine = text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? text;
    const parsed = JSON.parse(jsonLine);
    const content = parsed?.result?.content;
    if (Array.isArray(content)) {
      // MCP tool/call returns content array; first text block is the JSON payload
      const first = content[0];
      if (first?.type === 'text' && typeof first.text === 'string') {
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      }
    }
    return parsed?.result ?? null;
  } catch (e) {
    logger.debug('callMcpTool failed:', e);
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
      const start = formatTime(b.start);
      const end = formatTime(b.end);
      const app = b.app_name ?? '?';
      const summary = b.summary ?? b.entries?.[0]?.summary ?? '';
      return `[${start}-${end}, ${app}] ${summary}`.slice(0, 200);
    })
    .filter((line) => line.length > 6);
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
 * Never throws — failure is silent (graceful degradation).
 */
export async function fetchOpenchronicleContext(): Promise<string | null> {
  let settings;
  try {
    settings = await loadSettings();
  } catch {
    return null;
  }
  if (!settings.enabled || !settings.autoInjectContext) return null;

  const result = await callMcpTool('current_context', {
    headline_limit: 5,
    fulltext_limit: 2,
    timeline_limit: 5,
  });
  if (!result || typeof result !== 'object') return null;

  const filter = compileFilter(settings);
  const formatted = formatContext(result as CurrentContextResult, filter);
  if (!formatted.trim()) return null;
  return formatted;
}
