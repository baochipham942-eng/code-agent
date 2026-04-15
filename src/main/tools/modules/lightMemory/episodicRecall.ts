// ============================================================================
// EpisodicRecall — FTS5 keyword search over past session messages
// ============================================================================
// Workstream D of Hermes 四层记忆对标。LLM 在当前任务里遇到"感觉之前做过"
// 的情境时，用这个工具回查历史消息，而不是依赖压缩后的摘要。
//
// 底层：session_messages_fts (FTS5 virtual table, tokenize=trigram)
// 同步：databaseService 的 triggers 自动维护，应用代码无感
// 双模式：Electron 主进程用 DatabaseService；CLI 模式用 CLIDatabaseService。
//        两者都指向同一个 ~/.code-agent/code-agent.db，schema 也对齐。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { episodicRecallSchema } from './episodicRecall.schema';
import { getDatabase } from '../../../services';
import { MEMORY } from '../../../../shared/constants';

/**
 * duck-typed 最小接口 — 两个 DB 服务都实现 searchSessionMessagesFts
 */
interface SearchableDatabase {
  searchSessionMessagesFts(
    query: string,
    options: { limit?: number; sessionId?: string },
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }>;
}

/**
 * 运行时选 DB 源：CLI 模式走 CLIDatabaseService，主进程走 Electron DatabaseService
 */
function getSearchableDatabase(): SearchableDatabase | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    try {
      // 动态 require 避免 main → cli 的反向静态依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../../../cli/database') as {
        getCLIDatabase?: () => {
          isInitialized: boolean;
          searchSessionMessagesFts: SearchableDatabase['searchSessionMessagesFts'];
        };
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized) {
        return cliDb;
      }
    } catch {
      // CLI bundle 不可用时 fall through
    }
    return null;
  }

  const db = getDatabase();
  return db?.isReady ? (db as unknown as SearchableDatabase) : null;
}

interface EpisodicRecallArgs {
  query?: string;
  limit?: number;
  session_scope?: 'current' | 'all';
}

interface EpisodicRecallResult {
  total: number;
  snippets: Array<{
    sessionId: string;
    role: string;
    timestamp: number;
    timestampIso: string;
    snippet: string;
    messageId: string;
  }>;
}

class EpisodicRecallHandler
  implements ToolHandler<Record<string, unknown>, EpisodicRecallResult>
{
  readonly schema = episodicRecallSchema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<EpisodicRecallResult>> {
    const typed = args as EpisodicRecallArgs;

    // ---- Validation ------------------------------------------------------
    if (typeof typed.query !== 'string' || typed.query.trim().length === 0) {
      return { ok: false, error: 'query is required', code: 'INVALID_ARGS' };
    }
    const query = typed.query.trim();
    // trigram tokenizer 要求至少 3 个字符才能生成 trigram
    if (query.length < 3) {
      return {
        ok: false,
        error: 'query must be at least 3 characters (FTS5 trigram requirement)',
        code: 'INVALID_ARGS',
      };
    }
    if (query.length > 200) {
      return {
        ok: false,
        error: 'query too long (max 200 characters)',
        code: 'INVALID_ARGS',
      };
    }

    // limit: default 5, hard cap 10
    let limit = typeof typed.limit === 'number' ? Math.floor(typed.limit) : MEMORY.EPISODIC_RECALL_DEFAULT_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) {
      limit = MEMORY.EPISODIC_RECALL_DEFAULT_LIMIT;
    }
    if (limit > MEMORY.EPISODIC_RECALL_MAX_LIMIT) {
      limit = MEMORY.EPISODIC_RECALL_MAX_LIMIT;
    }

    const scope = typed.session_scope === 'current' ? 'current' : 'all';

    // ---- Permission ------------------------------------------------------
    const permit = await canUseTool(this.schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `recall ${query.slice(0, 40)}` });

    // ---- Query -----------------------------------------------------------
    const db = getSearchableDatabase();
    if (!db) {
      return {
        ok: false,
        error: 'database not ready',
        code: 'DB_NOT_READY',
      };
    }

    let rows: ReturnType<SearchableDatabase['searchSessionMessagesFts']>;
    try {
      rows = db.searchSessionMessagesFts(query, {
        limit,
        sessionId: scope === 'current' ? ctx.sessionId : undefined,
      });
    } catch (err) {
      // FTS5 MATCH syntax error → tell the model how to recover
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `FTS query failed: ${msg}. Try simpler terms or wrap phrases in double quotes.`,
        code: 'FTS_ERROR',
      };
    }

    // ---- Build snippets --------------------------------------------------
    const maxChars = MEMORY.EPISODIC_SNIPPET_MAX_CHARS;
    const snippets = rows.map((row) => ({
      sessionId: row.sessionId,
      role: row.role,
      timestamp: row.timestamp,
      timestampIso: new Date(row.timestamp).toISOString(),
      snippet:
        row.content.length > maxChars
          ? row.content.slice(0, maxChars) + '…'
          : row.content,
      messageId: row.messageId,
    }));

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('EpisodicRecall done', {
      query,
      scope,
      resultCount: snippets.length,
    });

    return {
      ok: true,
      output: {
        total: snippets.length,
        snippets,
      },
    };
  }
}

export const episodicRecallModule: ToolModule<Record<string, unknown>, EpisodicRecallResult> = {
  schema: episodicRecallSchema,
  createHandler() {
    return new EpisodicRecallHandler();
  },
};
