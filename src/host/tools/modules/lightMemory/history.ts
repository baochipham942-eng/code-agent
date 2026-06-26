// ============================================================================
// History — 会话转录全文检索 + 上下文回放（roadmap 2.1）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — tool/history.ts
// 的 search/around 双 action 设计；实现按 Neo 的 ToolModule 协议重写。
//
// 与 EpisodicRecall 的分工：EpisodicRecall 只搜消息正文（session_messages_fts），
// History 搜按 kind 分解的完整转录（transcript_fts：含 reasoning / tool 输入输出），
// 并提供 around 取锚点上下文。memory 是策展知识，history 是逐字原始日志。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { historySchema } from './history.schema';
import { getDatabase } from '../../../services';
import { MEMORY } from '../../../../shared/constants';
import { TRANSCRIPT_KINDS, type TranscriptKind } from '../../../../shared/transcriptFts.sql';
import type { Message } from '../../../../shared/contract';

// ----------------------------------------------------------------------------
// duck-typed 最小接口 — Electron DatabaseService 与 CLIDatabaseService 都实现
// ----------------------------------------------------------------------------

interface TranscriptSearchHit {
  messageId: string;
  sessionId: string;
  kind: TranscriptKind;
  toolName: string | null;
  snippet: string;
  timestamp: number;
}

interface TranscriptDatabase {
  searchTranscriptFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      kinds?: TranscriptKind[];
      toolName?: string;
      timeAfter?: number;
      timeBefore?: number;
    }
  ): TranscriptSearchHit[];
  getTranscriptAround(
    messageId: string,
    options: { before?: number; after?: number }
  ): { sessionId: string; messages: Array<{ message: Message; matched: boolean }> } | null;
}

function getTranscriptDatabase(): TranscriptDatabase | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    try {
      // 动态 require 避免 main → cli 的反向静态依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../../../cli/database') as {
        getCLIDatabase?: () => ({ isInitialized: boolean } & Partial<TranscriptDatabase>) | undefined;
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized && typeof cliDb.searchTranscriptFts === 'function' && typeof cliDb.getTranscriptAround === 'function') {
        return cliDb as TranscriptDatabase;
      }
    } catch {
      // CLI bundle 不可用时 fall through
    }
    return null;
  }

  const db = getDatabase();
  return db?.isReady ? (db as unknown as TranscriptDatabase) : null;
}

// ----------------------------------------------------------------------------
// Args / Output types
// ----------------------------------------------------------------------------

interface HistoryArgs {
  action?: 'search' | 'around';
  query?: string;
  kinds?: string[];
  tool_name?: string;
  time_after?: number;
  time_before?: number;
  session_scope?: 'current' | 'all';
  limit?: number;
  message_id?: string;
  before?: number;
  after?: number;
}

interface HistorySearchOutput {
  total: number;
  hits: Array<{
    messageId: string;
    sessionId: string;
    kind: TranscriptKind;
    toolName: string | null;
    timestamp: number;
    timestampIso: string;
    snippet: string;
  }>;
  hint?: string;
}

interface HistoryAroundOutput {
  sessionId: string;
  total: number;
  messages: Array<{
    messageId: string;
    role: string;
    matched: boolean;
    timestamp: number;
    timestampIso: string;
    content?: string;
    thinking?: string;
    toolCalls?: Array<{
      name: string;
      arguments: string;
      output?: string;
    }>;
  }>;
}

type HistoryOutput = HistorySearchOutput | HistoryAroundOutput;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function truncateText(text: string, max = MEMORY.HISTORY_PART_TEXT_MAX_CHARS): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function clampNumber(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), max);
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

class HistoryHandler implements ToolHandler<Record<string, unknown>, HistoryOutput> {
  readonly schema = historySchema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<HistoryOutput>> {
    const typed = args as HistoryArgs;

    if (typed.action !== 'search' && typed.action !== 'around') {
      return {
        ok: false,
        error: 'action must be "search" or "around"',
        code: 'INVALID_ARGS',
      };
    }

    // ---- Validation ------------------------------------------------------
    let kinds: TranscriptKind[] | undefined;
    if (typed.action === 'search') {
      if (typeof typed.query !== 'string' || typed.query.trim().length === 0) {
        return { ok: false, error: 'action=search requires a query', code: 'INVALID_ARGS' };
      }
      if (typed.query.trim().length < 3) {
        return {
          ok: false,
          error: 'query must be at least 3 characters (FTS5 trigram requirement)',
          code: 'INVALID_ARGS',
        };
      }
      if (typed.query.length > 200) {
        return { ok: false, error: 'query too long (max 200 characters)', code: 'INVALID_ARGS' };
      }
      if (typed.kinds !== undefined) {
        if (!Array.isArray(typed.kinds)) {
          return { ok: false, error: 'kinds must be an array', code: 'INVALID_ARGS' };
        }
        const invalid = typed.kinds.filter((k) => !(TRANSCRIPT_KINDS as readonly string[]).includes(k));
        if (invalid.length > 0) {
          return {
            ok: false,
            error: `invalid kind(s): ${invalid.join(', ')}. Valid: ${TRANSCRIPT_KINDS.join(', ')}`,
            code: 'INVALID_ARGS',
          };
        }
        kinds = typed.kinds as TranscriptKind[];
      }
    } else if (typeof typed.message_id !== 'string' || typed.message_id.trim().length === 0) {
      return { ok: false, error: 'action=around requires a message_id (take it from a search hit)', code: 'INVALID_ARGS' };
    }

    // ---- Permission ------------------------------------------------------
    const permit = await canUseTool(this.schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const db = getTranscriptDatabase();
    if (!db) {
      return { ok: false, error: 'database not ready', code: 'DB_NOT_READY' };
    }

    if (typed.action === 'search') {
      return this.runSearch(typed, kinds, db, ctx, onProgress);
    }
    return this.runAround(typed, db, ctx, onProgress);
  }

  private runSearch(
    typed: HistoryArgs,
    kinds: TranscriptKind[] | undefined,
    db: TranscriptDatabase,
    ctx: ToolContext,
    onProgress?: ToolProgressFn,
  ): ToolResult<HistoryOutput> {
    const query = (typed.query as string).trim();
    onProgress?.({ stage: 'starting', detail: `history search ${query.slice(0, 40)}` });

    const limit = clampNumber(typed.limit, MEMORY.HISTORY_SEARCH_DEFAULT_LIMIT, MEMORY.HISTORY_SEARCH_MAX_LIMIT) || MEMORY.HISTORY_SEARCH_DEFAULT_LIMIT;

    let rows: TranscriptSearchHit[];
    try {
      rows = db.searchTranscriptFts(query, {
        kinds,
        toolName: typeof typed.tool_name === 'string' ? typed.tool_name : undefined,
        timeAfter: typeof typed.time_after === 'number' ? typed.time_after : undefined,
        timeBefore: typeof typed.time_before === 'number' ? typed.time_before : undefined,
        sessionId: typed.session_scope === 'current' ? ctx.sessionId : undefined,
        limit,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `FTS query failed: ${msg}. Try simpler terms or wrap phrases in double quotes.`,
        code: 'FTS_ERROR',
      };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('History search done', { query, resultCount: rows.length });

    const output: HistorySearchOutput = {
      total: rows.length,
      hits: rows.map((row) => ({
        messageId: row.messageId,
        sessionId: row.sessionId,
        kind: row.kind,
        toolName: row.toolName,
        timestamp: row.timestamp,
        timestampIso: new Date(row.timestamp).toISOString(),
        snippet: row.snippet,
      })),
    };
    if (rows.length === 0) {
      output.hint =
        'No transcript matches. Try broader terms, drop kind/tool_name filters, or use MemoryRead for curated knowledge.';
    }
    return { ok: true, output };
  }

  private runAround(
    typed: HistoryArgs,
    db: TranscriptDatabase,
    ctx: ToolContext,
    onProgress?: ToolProgressFn,
  ): ToolResult<HistoryOutput> {
    const messageId = (typed.message_id as string).trim();
    onProgress?.({ stage: 'starting', detail: `history around ${messageId}` });

    const before = clampNumber(typed.before, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW, MEMORY.HISTORY_AROUND_MAX_WINDOW);
    const after = clampNumber(typed.after, MEMORY.HISTORY_AROUND_DEFAULT_WINDOW, MEMORY.HISTORY_AROUND_MAX_WINDOW);

    const around = db.getTranscriptAround(messageId, { before, after });
    if (!around) {
      return {
        ok: false,
        error: `no message with id ${messageId} — use a messageId from a History search hit`,
        code: 'NOT_FOUND',
      };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('History around done', { messageId, count: around.messages.length });

    const output: HistoryAroundOutput = {
      sessionId: around.sessionId,
      total: around.messages.length,
      messages: around.messages.map(({ message, matched }) => {
        const entry: HistoryAroundOutput['messages'][number] = {
          messageId: message.id,
          role: message.role,
          matched,
          timestamp: message.timestamp,
          timestampIso: new Date(message.timestamp).toISOString(),
        };
        if (typeof message.content === 'string' && message.content.length > 0) {
          entry.content = truncateText(message.content);
        }
        if (typeof message.thinking === 'string' && message.thinking.length > 0) {
          entry.thinking = truncateText(message.thinking);
        }
        if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
          entry.toolCalls = message.toolCalls.map((tc) => {
            const call: { name: string; arguments: string; output?: string } = {
              name: tc.name,
              arguments: truncateText(JSON.stringify(tc.arguments ?? {})),
            };
            if (tc.result) {
              const raw = tc.result.output ?? '';
              const err = tc.result.error ? `${raw ? `${raw} ` : ''}ERROR: ${tc.result.error}` : raw;
              if (err) call.output = truncateText(err);
            }
            return call;
          });
        }
        return entry;
      }),
    };
    return { ok: true, output };
  }
}

export const historyModule: ToolModule<Record<string, unknown>, HistoryOutput> = {
  schema: historySchema,
  createHandler() {
    return new HistoryHandler();
  },
};
