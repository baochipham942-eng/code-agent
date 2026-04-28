// ============================================================================
// Compaction Snapshot Writer — 上下文压缩前后落一条快照到 compaction_snapshots
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CompactionSnapshotWriter');

interface CompactionSink {
  insertCompactionSnapshot: (input: {
    sessionId: string;
    strategy?: string | null;
    preMessageCount: number;
    postMessageCount: number;
    preTokens: number;
    postTokens: number;
    savedTokens: number;
    usagePercent?: number | null;
    preMessagesSummary?: unknown;
    postMessagesSummary?: unknown;
    createdAt?: number;
  }) => { id: string; createdAt: number; byteSize: number };
}

function getSink(): CompactionSink | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../cli/database') as {
        getCLIDatabase?: () => { isInitialized: boolean } & CompactionSink;
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized) return cliDb;
    } catch {
      // CLI bundle 不可用时静默 no-op
    }
    return null;
  }
  const db = getDatabase();
  return db?.isReady ? (db as unknown as CompactionSink) : null;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  toolCalls?: unknown[];
}

function summarize(messages: MessageLike[]): Array<{ role: string; contentLength: number; hasToolCalls: boolean }> {
  return messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const tcs = m.tool_calls ?? m.toolCalls ?? [];
    return {
      role: String(m.role ?? 'unknown'),
      contentLength: content.length,
      hasToolCalls: Array.isArray(tcs) && tcs.length > 0,
    };
  });
}

export interface CompactionSnapshotInput {
  sessionId: string;
  strategy: string;
  preMessages: MessageLike[];
  postMessages: MessageLike[];
  preTokens: number;
  postTokens: number;
  savedTokens: number;
  usagePercent?: number;
}

/**
 * 落一条 compaction snapshot。错误不阻塞压缩主路径。
 */
export function writeCompactionSnapshot(input: CompactionSnapshotInput): void {
  try {
    const sink = getSink();
    if (!sink) return;
    sink.insertCompactionSnapshot({
      sessionId: input.sessionId,
      strategy: input.strategy,
      preMessageCount: input.preMessages.length,
      postMessageCount: input.postMessages.length,
      preTokens: input.preTokens,
      postTokens: input.postTokens,
      savedTokens: input.savedTokens,
      usagePercent: input.usagePercent ?? null,
      preMessagesSummary: summarize(input.preMessages),
      postMessagesSummary: summarize(input.postMessages),
    });
  } catch (err) {
    logger.warn('[CompactionSnapshotWriter] failed to write snapshot', err);
  }
}
