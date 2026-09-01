import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { applySchema } from '../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../src/host/services/core/database/migrations';
import {
  applyConversationBranchSchema,
  canonicalConversationJson,
  canonicalConversationMessagePayload,
} from '../../src/host/services/core/database/schemaConversationBranch';
import { sanitizeConversationMessageSnapshot } from '../../src/host/services/core/conversationMessageSnapshot';
import { ConversationBranchRepository } from '../../src/host/services/core/repositories/ConversationBranchRepository';
import { ConversationBranchLedgerStore } from '../../src/host/services/core/repositories/ConversationBranchLedgerStore';
import { SessionRepository } from '../../src/host/services/core/repositories/SessionRepository';
import { rowToMessage } from '../../src/host/services/core/repositories/sessionRepositoryParsers';
import { createLogger } from '../../src/host/services/infra/logger';
import type { Message } from '../../src/shared/contract';

type SQLiteRow = Record<string, unknown>;

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function canonicalProjectionMessage(message: Message): string {
  const snapshot = sanitizeConversationMessageSnapshot(message);
  return canonicalConversationJson({
    id: snapshot.id,
    payload: canonicalConversationMessagePayload(snapshot as Record<string, unknown>),
  });
}

function runLiveDiff(): void {
  const dbPath = path.join(os.homedir(), '.code-agent', 'code-agent.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ledger = new ConversationBranchRepository(db);
    const store = new ConversationBranchLedgerStore(db);
    const sessions = db.prepare(`
      SELECT session.id, session.user_id, session.project_id
      FROM sessions session
      JOIN conversation_branches branch ON branch.session_id = session.id
      WHERE COALESCE(session.is_deleted, 0) = 0
      ORDER BY session.id ASC
    `).all() as Array<{ id: string; user_id: string | null; project_id: string | null }>;
    const differences: Array<Record<string, unknown>> = [];
    let comparedMessages = 0;
    let replayErrors = 0;

    for (const session of sessions) {
      const projectionMessages = (db.prepare(`
        SELECT rowid AS __rowid, *
        FROM messages
        WHERE session_id = ? AND COALESCE(visibility, 'active') = 'active'
        ORDER BY timestamp ASC, rowid ASC
      `).all(session.id) as SQLiteRow[]).map((row) => rowToMessage(row));
      const projection = projectionMessages.map(canonicalProjectionMessage);
      try {
        const replay = ledger.replay(session.id, {
          ownerUserId: session.user_id,
          projectId: session.project_id,
        }).messages.map((entry) => canonicalProjectionMessage(entry.message as Message));
        comparedMessages += Math.max(projection.length, replay.length);
        const length = Math.max(projection.length, replay.length);
        for (let index = 0; index < length; index += 1) {
          if (projection[index] !== replay[index]) {
            differences.push({
              sessionId: session.id,
              index,
              projection: projection[index] ?? null,
              replay: replay[index] ?? null,
            });
          }
        }
      } catch (error) {
        replayErrors += 1;
        const branch = store.readBranchBySession(session.id);
        const uncheckedMessages = branch
          ? store.replayFromRows(
              branch,
              store.readReferences(branch.id),
              store.readEvents(branch.id),
            ).messages.map((entry) => entry.message as Message)
          : [];
        const unchecked = uncheckedMessages.map(canonicalProjectionMessage);
        const mismatchedIndexes = Array.from(
          { length: Math.max(projection.length, unchecked.length) },
          (_value, index) => index,
        ).filter((index) => projection[index] !== unchecked[index]);
        differences.push({
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
          projectionMessageIds: projectionMessages.map((message) => message.id),
          uncheckedReplayMessageIds: uncheckedMessages.map((message) => message.id),
          sameMessageSet: [...projectionMessages.map((message) => message.id)].sort().join('\n')
            === [...uncheckedMessages.map((message) => message.id)].sort().join('\n'),
          mismatchedIndexes,
          canonicalPayloadsMatchByMessageId: projectionMessages.every((message) => {
            const replayMessage = uncheckedMessages.find((candidate) => candidate.id === message.id);
            return replayMessage
              ? canonicalProjectionMessage(replayMessage) === canonicalProjectionMessage(message)
              : false;
          }),
        });
      }
    }

    console.log(JSON.stringify({
      mode: 'live-diff',
      dbPath,
      readonly: true,
      sessionCount: sessions.length,
      comparedMessages,
      replayErrors,
      differenceCount: differences.length,
      differences,
    }, null, 2));
    if (differences.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function runPerformance(): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'n-readflip-perf-'));
  const dbPath = path.join(tempDir, 'benchmark.db');
  const db = new Database(dbPath);
  const logger = createLogger('n-readflip-performance');
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    const ledger = new ConversationBranchRepository(db);
    const sessionId = 'n-readflip-1200';
    const boundary = { ownerUserId: null, projectId: null } as const;
    sessions.createSession({
      id: sessionId,
      userId: null,
      projectId: null,
      title: 'N-READFLIP performance',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    for (let index = 0; index < 1_200; index += 1) {
      sessions.addMessage(sessionId, {
        id: `message-${String(index).padStart(4, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index} ${'payload '.repeat(64)}`,
        timestamp: index + 1,
        metadata: { correlation: { turnId: `benchmark-${index}` } },
      });
    }

    ledger.replayForLoad(sessionId, boundary);
    for (let index = 0; index < 10; index += 1) {
      sessions.getRecentMessages(sessionId, Number.MAX_SAFE_INTEGER);
      ledger.replayForLoad(sessionId, boundary).messages.map((entry) => entry.message);
    }

    const beforeMs: number[] = [];
    const afterMs: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const beforeStart = performance.now();
      sessions.getRecentMessages(sessionId, Number.MAX_SAFE_INTEGER);
      beforeMs.push(performance.now() - beforeStart);

      const afterStart = performance.now();
      ledger.replayForLoad(sessionId, boundary).messages.map((entry) => entry.message);
      afterMs.push(performance.now() - afterStart);
    }

    console.log(JSON.stringify({
      mode: 'performance',
      messageCount: 1_200,
      sampleCountPerPath: 100,
      warmupCountPerPath: 10,
      beforeProjectionReadMs: {
        p50: percentile(beforeMs, 0.5),
        p95: percentile(beforeMs, 0.95),
        min: Math.min(...beforeMs),
        max: Math.max(...beforeMs),
      },
      afterLoadingReplayMs: {
        p50: percentile(afterMs, 0.5),
        p95: percentile(afterMs, 0.95),
        min: Math.min(...afterMs),
        max: Math.max(...afterMs),
      },
      machine: {
        platform: `${process.platform}-${process.arch}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        loadAverageBeforeReport: os.loadavg(),
        processRssBytes: process.memoryUsage().rss,
      },
    }, null, 2));
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === '--live-diff') {
  runLiveDiff();
} else if (mode === '--performance') {
  runPerformance();
} else {
  throw new Error('Usage: npx tsx scripts/acceptance/n-readflip-evidence.ts --live-diff|--performance');
}
