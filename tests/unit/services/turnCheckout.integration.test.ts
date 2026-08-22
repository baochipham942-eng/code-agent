import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({ service: null as null | {
  isReady: boolean;
  getDb: () => BetterSqlite3.Database;
} }));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => databaseState.service,
}));

import { makeEvidenceRef } from '../../../src/shared/contract/evidence';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { FileCheckpointService } from '../../../src/host/services/checkpoint/fileCheckpointService';
import { invalidateSessionEvidence } from '../../../src/host/services/checkpoint/evidenceInvalidationService';
import { TurnCheckoutService } from '../../../src/host/services/checkpoint/turnCheckoutService';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { SessionRewindService } from '../../../src/host/services/sessionRewind/SessionRewindService';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function digestState(db: BetterSqlite3.Database): string {
  const row = db.prepare(
    "SELECT event_data FROM session_events WHERE session_id = 'session-turn' LIMIT 1",
  ).get() as { event_data: string };
  const payload = JSON.parse(row.event_data) as { evidenceRefs: Array<{ freshness: { state: string } }> };
  return payload.evidenceRefs[0].freshness.state;
}

describe('atomic turn checkout integration', () => {
  let db: BetterSqlite3.Database;
  let repository: SessionRepository;
  let checkpointService: FileCheckpointService;
  let rewindService: SessionRewindService;
  let tempDir: string;
  let fileA: string;
  let fileB: string;
  let checkpointMessageId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyIndexes(db);
    databaseState.service = { isReady: true, getDb: () => db };
    repository = new SessionRepository(db);
    checkpointService = new FileCheckpointService();
    rewindService = new SessionRewindService(repository, { ownerUserId: null });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-checkout-'));
    fileA = path.join(tempDir, 'a.txt');
    fileB = path.join(tempDir, 'b.txt');
    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (
        id, title, model_provider, model_name, session_type,
        created_at, updated_at, status, is_deleted
      ) VALUES ('session-turn', 'Turn', 'openai', 'gpt-5', 'chat', ?, ?, 'idle', 0)
    `).run(now - 2_000, now - 2_000);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, is_meta, visibility
      ) VALUES (?, 'session-turn', ?, ?, ?, 0, 'active')
    `);
    insertMessage.run('user-target', 'user', 'change two files', now - 1_500);
    insertMessage.run('assistant-suffix', 'assistant', 'done', now - 500);
    db.prepare(`
      INSERT INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status,
        hidden_by_rewind_id, created_at, updated_at
      ) VALUES (
        'ui-turn', 'session-turn', 'assistant-suffix', 0, 'turn-source',
        'hash', '{}', '{}', 0, 'active', NULL, ?, ?
      )
    `).run(now - 500, now - 500);
    db.prepare(`
      INSERT INTO execution_manifests (
        manifest_id, session_id, instance_id, nonce, scope_hash, title, summary,
        items_json, status, expires_at, created_at, updated_at
      ) VALUES (
        'manifest-turn', 'session-turn', 'ui-turn', 'nonce', 'scope', 'Turn', 'Turn',
        '[]', 'pending', ?, ?, ?
      )
    `).run(now + 60_000, now - 500, now - 500);
    const evidence = makeEvidenceRef({
      id: 'evidence-test-turn',
      kind: 'test',
      ref: `${tempDir}$ npm test`,
      source: 'VerificationRunner',
      state: 'fresh',
    });
    db.prepare(`
      INSERT INTO session_events (session_id, event_type, event_data, timestamp)
      VALUES ('session-turn', 'goal_evidence_gate', ?, ?)
    `).run(JSON.stringify({ evidenceRefs: [evidence] }), now - 400);

    await fs.writeFile(fileA, 'before-a', 'utf-8');
    checkpointMessageId = 'tool-write-a';
    const checkpointA = await checkpointService.createCheckpoint(
      'session-turn',
      checkpointMessageId,
      fileA,
    );
    await fs.writeFile(fileA, 'latest-a', 'utf-8');
    expect(await checkpointService.finalizeCheckpointDigest(checkpointA!, fileA)).toBe(true);

    await fs.writeFile(fileB, 'before-b', 'utf-8');
    const checkpointB = await checkpointService.createCheckpoint(
      'session-turn',
      'tool-write-b',
      fileB,
    );
    await fs.writeFile(fileB, 'latest-b', 'utf-8');
    expect(await checkpointService.finalizeCheckpointDigest(checkpointB!, fileB)).toBe(true);
  });

  afterEach(async () => {
    databaseState.service = null;
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function service(overrides: Partial<ConstructorParameters<typeof TurnCheckoutService>[0]> = {}): TurnCheckoutService {
    return new TurnCheckoutService({
      rewindFiles: (sessionId, messageId, options) => checkpointService.rewindFiles(sessionId, messageId, options),
      redoFiles: (sessionId, messageId, restoredFrom) => checkpointService.redoFiles(sessionId, messageId, restoredFrom),
      rewindConversation: (request, record) => rewindService.rewindConversation(request, record),
      restoreConversation: (request) => rewindService.restoreConversation(request),
      invalidateEvidence: (sessionId, paths) => invalidateSessionEvidence(
        db,
        sessionId,
        paths,
        { ledgerPaths: [] },
      ),
      writeNote: async () => repository.getMessages('session-turn'),
      ...overrides,
    });
  }

  it('checks out files + conversation + manifest + evidence and Redoes files + conversation while evidence stays stale', async () => {
    const checkout = await service().checkout({
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-integration',
    }, checkpointMessageId);

    expect(checkout.state).toBe('success');
    expect(await fs.readFile(fileA, 'utf-8')).toBe('before-a');
    expect(await fs.readFile(fileB, 'utf-8')).toBe('before-b');
    expect(repository.getMessages('session-turn').map((message) => message.id)).toEqual(['user-target']);
    expect(db.prepare(
      "SELECT status, invalidation_reason FROM execution_manifests WHERE manifest_id = 'manifest-turn'",
    ).get()).toEqual({ status: 'invalidated', invalidation_reason: 'SOURCE_REWOUND' });
    expect(digestState(db)).toBe('stale');
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = 'session-turn'",
    ).get()).toEqual({ count: 4 });

    const audit = repository.rewindRepo.getPromptRewindAudit('session-turn', checkout.rewindId!, null);
    expect(audit.redoCheckpointMessageId).toMatch(/^turn_redo_snapshot_/);
    const redo = await service().redo({
      sessionId: 'session-turn',
      rewindId: checkout.rewindId!,
    }, audit.redoCheckpointMessageId);

    expect(redo.state).toBe('success');
    expect(await fs.readFile(fileA, 'utf-8')).toBe('latest-a');
    expect(await fs.readFile(fileB, 'utf-8')).toBe('latest-b');
    expect(repository.getMessages('session-turn').map((message) => message.id)).toEqual([
      'user-target',
      'assistant-suffix',
    ]);
    expect(digestState(db)).toBe('stale');
  });

  it('skips a manually edited file, restores the rest, and reports partial honestly', async () => {
    await fs.writeFile(fileA, 'human-edit-after-agent', 'utf-8');

    const result = await service().checkout({
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-human-edit',
    }, checkpointMessageId);

    expect(result.state).toBe('partial');
    expect(result.skippedFiles).toEqual([
      expect.objectContaining({ filePath: fileA, reason: 'human_edit' }),
    ]);
    expect(await fs.readFile(fileA, 'utf-8')).toBe('human-edit-after-agent');
    expect(await fs.readFile(fileB, 'utf-8')).toBe('before-b');
    expect(repository.getMessages('session-turn').map((message) => message.id)).toEqual(['user-target']);
  });

  it('returns partial when conversation step fails after files were already written', async () => {
    const result = await service({
      rewindConversation: vi.fn(async () => {
        throw new Error('injected conversation failure');
      }),
    }).checkout({
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-step-two-failure',
    }, checkpointMessageId);

    expect(result.state).toBe('partial');
    expect(result.done).toContain('workspace');
    expect(result.failed).toContainEqual(expect.objectContaining({
      step: 'conversation',
      reason: 'injected conversation failure',
    }));
    expect(await fs.readFile(fileA, 'utf-8')).toBe('before-a');
    expect(await fs.readFile(fileB, 'utf-8')).toBe('before-b');
    expect(repository.getMessages('session-turn').map((message) => message.id)).toEqual([
      'user-target',
      'assistant-suffix',
    ]);
    expect(digestState(db)).toBe('stale');
  });

  it('returns partial and still restores the conversation when Redo file restore throws', async () => {
    const checkout = await service().checkout({
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-before-redo-failure',
    }, checkpointMessageId);
    const audit = repository.rewindRepo.getPromptRewindAudit('session-turn', checkout.rewindId!, null);

    const redo = await service({
      redoFiles: vi.fn(async () => {
        throw new Error('injected Redo file failure');
      }),
    }).redo({
      sessionId: 'session-turn',
      rewindId: checkout.rewindId!,
    }, audit.redoCheckpointMessageId);

    expect(redo.state).toBe('partial');
    expect(redo.failed).toContainEqual(expect.objectContaining({
      step: 'workspace',
      reason: 'injected Redo file failure',
    }));
    expect(redo.done).toContain('conversation');
    expect(repository.getMessages('session-turn').map((message) => message.id)).toEqual([
      'user-target',
      'assistant-suffix',
    ]);
    expect(await fs.readFile(fileA, 'utf-8')).toBe('before-a');
    expect(digestState(db)).toBe('stale');
  });

  it('reuses the same workspace snapshot when an idempotent checkout is retried', async () => {
    const request = {
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-idempotent-retry',
    };
    const first = await service().checkout(request, checkpointMessageId);
    const second = await service().checkout(request, checkpointMessageId);

    expect(second.state).toBe('success');
    expect(second.rewindId).toBe(first.rewindId);
    expect(await fs.readFile(fileA, 'utf-8')).toBe('before-a');
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = 'session-turn'",
    ).get()).toEqual({ count: 4 });

    const audit = repository.rewindRepo.getPromptRewindAudit('session-turn', first.rewindId!, null);
    await expect(service().redo({
      sessionId: 'session-turn',
      rewindId: first.rewindId!,
    }, audit.redoCheckpointMessageId)).resolves.toMatchObject({ state: 'success' });
    expect(await fs.readFile(fileA, 'utf-8')).toBe('latest-a');
  });

  it('marks only the latest completed rewind as safe to Redo before file writes', async () => {
    const first = await rewindService.rewindConversation({
      sessionId: 'session-turn',
      anchorUserMessageId: 'user-target',
      idempotencyKey: 'nested-rewind-first',
    });
    const second = await rewindService.rewindConversation({
      sessionId: 'session-turn',
      anchorUserMessageId: 'user-target',
      idempotencyKey: 'nested-rewind-second',
    });

    expect(repository.rewindRepo.getPromptRewindAudit('session-turn', first.rewindId, null).isLatestCompleted)
      .toBe(false);
    expect(repository.rewindRepo.getPromptRewindAudit('session-turn', second.rewindId, null).isLatestCompleted)
      .toBe(true);
  });

  it('appends ledger invalidation overlays without replacing existing JSONL records', async () => {
    const ledgerPath = path.join(tempDir, 'evidence-ledger.jsonl');
    const originalLine = JSON.stringify({ sessionId: 'other-session', value: 'keep-me' });
    await fs.writeFile(ledgerPath, `${originalLine}\n`, 'utf-8');

    await invalidateSessionEvidence(
      db,
      'session-turn',
      [fileA],
      { ledgerPaths: [ledgerPath] },
    );

    const lines = (await fs.readFile(ledgerPath, 'utf-8')).trim().split('\n');
    expect(lines[0]).toBe(originalLine);
    expect(JSON.parse(lines[1])).toMatchObject({
      recordType: 'turn_checkout_evidence_invalidation',
      sessionId: 'session-turn',
    });
    expect(digestState(db)).toBe('stale');
  });

  it('skips a file manually edited after checkout when Redo runs', async () => {
    const checkout = await service().checkout({
      sessionId: 'session-turn',
      userMessageId: 'user-target',
      idempotencyKey: 'checkout-before-redo-human-edit',
    }, checkpointMessageId);
    const audit = repository.rewindRepo.getPromptRewindAudit('session-turn', checkout.rewindId!, null);
    await fs.writeFile(fileA, 'human-edit-after-checkout', 'utf-8');

    const redo = await service().redo({
      sessionId: 'session-turn',
      rewindId: checkout.rewindId!,
    }, audit.redoCheckpointMessageId);

    expect(redo.state).toBe('partial');
    expect(redo.skippedFiles).toContainEqual(expect.objectContaining({
      filePath: fileA,
      reason: 'human_edit',
    }));
    expect(await fs.readFile(fileA, 'utf-8')).toBe('human-edit-after-checkout');
    expect(await fs.readFile(fileB, 'utf-8')).toBe('latest-b');
    expect(redo.done).toContain('conversation');
    expect(digestState(db)).toBe('stale');
  });
});
