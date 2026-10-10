import { existsSync, readFileSync, statSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionResult } from '../../../src/host/tools/types';

const mockConfig = vi.hoisted(() => ({
  userConfigDir: '',
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfig.userConfigDir,
}));

// 轮转测试用小阈值触发真实轮转；真实默认值单独用 importActual 断言。
// getter 让各测试可以按需调阈值（store 在每次追加时动态读取 MAX_SHARD_BYTES）。
const mockProofLedger = vi.hoisted(() => ({
  maxShardBytes: 512,
  keptShards: 4,
}));

vi.mock('@shared/constants', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  PROOF_LEDGER: {
    get MAX_SHARD_BYTES() { return mockProofLedger.maxShardBytes; },
    get KEPT_SHARDS() { return mockProofLedger.keptShards; },
  },
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { invalidateSessionEvidence } from '../../../src/host/services/checkpoint/evidenceInvalidationService';

import {
  appendBrowserComputerProofLedgerLine,
  getBrowserComputerProofLedgerPath,
  persistBrowserComputerProofFromResult,
  readBrowserComputerProofRecordsBySession,
} from '../../../src/host/session/browserComputerProofStore';
import { exportSessionToMarkdown } from '../../../src/host/session/exportMarkdown';

describe('browserComputerProofStore', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'browser-computer-proof-store-'));
    mockConfig.userConfigDir = tempRoot;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function makeResult(): ToolExecutionResult {
    return {
      success: true,
      output: 'Screenshot saved at /Users/linchen/Desktop/private.png',
      metadata: {
        traceId: 'trace-1',
        browserComputerProof: {
          evidenceRefs: [{
            id: 'evidence-1',
            kind: 'screenshot',
            ref: '/Users/linchen/Desktop/private.png',
            source: 'screenshot',
            freshness: { capturedAtMs: 1, state: 'fresh' },
          }, {
            id: 'evidence-2',
            kind: 'screenshot',
            ref: 'data:image/png;base64,abcdef',
            source: 'screenshot',
            freshness: { capturedAtMs: 1, state: 'fresh' },
          }],
          visualObservation: {
            observed: false,
            source: 'none',
            reason: 'screenshot_path_only',
            cannotObserveScreen: true,
          },
        },
        browserComputerEvidenceCard: {
          title: 'Browser/Computer Evidence',
          status: 'not_observed',
          summary: 'screenshot_path_only',
          evidenceRefIds: ['evidence-1', 'evidence-2'],
        },
      },
    };
  }

  it('persists sanitized Browser/Computer proof records by session', async () => {
    const record = persistBrowserComputerProofFromResult(makeResult(), {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'screenshot',
      now: () => 123,
    });

    expect(record).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'screenshot',
      status: 'not_observed',
      summary: 'screenshot_path_only',
      traceId: 'trace-1',
      evidenceRefIds: ['evidence-1', 'evidence-2'],
      targetKind: 'screenshot',
    }));

    const rawLedger = await readFile(getBrowserComputerProofLedgerPath(), 'utf-8');
    expect(rawLedger).not.toContain('/Users/linchen');
    expect(rawLedger).not.toContain('base64,abcdef');
    expect(rawLedger).toContain('.../private.png');

    const records = readBrowserComputerProofRecordsBySession('session-1');
    expect(records).toHaveLength(1);
    expect(records[0].card).toEqual(expect.objectContaining({
      status: 'not_observed',
      summary: 'screenshot_path_only',
    }));
  });

  it('does not write records without a session or proof payload', () => {
    expect(persistBrowserComputerProofFromResult(makeResult(), {
      toolName: 'screenshot',
    })).toBeNull();
    expect(persistBrowserComputerProofFromResult({
      success: true,
      metadata: {},
    }, {
      sessionId: 'session-1',
      toolName: 'screenshot',
    })).toBeNull();
    expect(readBrowserComputerProofRecordsBySession('session-1')).toEqual([]);
  });

  it('persists the additive Surface evidence card without changing the legacy schema', async () => {
    const record = persistBrowserComputerProofFromResult({
      success: false,
      metadata: {
        surfaceEvidenceCardV1: {
          version: 1,
          evidenceId: 'surface-proof-1',
          summary: 'Verification surface-secret-canary-ledger failed.',
          inspection: { verificationState: 'rejected' },
        },
        surfaceProofScopeV1: {
          version: 1,
          conversationId: 'session-surface',
          runId: 'run-1',
          agentId: 'agent-1',
          surfaceSessionId: 'surface-1',
          operationId: 'operation-1',
        },
      },
    }, {
      sessionId: 'session-surface',
      toolCallId: 'operation-1',
      toolName: 'computer_use',
      now: () => 456,
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      status: 'rejected',
      evidenceRefIds: ['surface-proof-1'],
      targetKind: 'computer',
      surfaceEvidenceCard: { evidenceId: 'surface-proof-1' },
      surfaceScope: { surfaceSessionId: 'surface-1' },
    });
    expect(record?.summary).toBe('Verification [redacted-canary] failed.');
    const rawLedger = await readFile(getBrowserComputerProofLedgerPath(), 'utf-8');
    expect(rawLedger).not.toContain('surface-secret-canary-ledger');
  });

  it('adds proof records to the unified evidence control summary in markdown exports', () => {
    persistBrowserComputerProofFromResult(makeResult(), {
      sessionId: 'session-export',
      toolCallId: 'tool-export',
      toolName: 'screenshot',
      now: () => 123,
    });

    const result = exportSessionToMarkdown({
      sessionId: 'session-export',
      startedAt: 1,
      lastActivityAt: 2,
      totalTokens: 0,
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Proof exported',
        timestamp: 1,
      }],
    }, {
      includeMetadata: true,
      includeTimestamps: false,
    });

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('## Evidence Control Summary');
    expect(result.markdown).toContain('browser/computer 1');
    expect(result.markdown).toContain('browser_computer · not_observed · screenshot_path_only');
    expect(result.markdown).toContain('evidence-1');
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('base64,abcdef');
  });
});

describe('browserComputerProofStore ledger rotation', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'browser-computer-proof-rotation-'));
    mockConfig.userConfigDir = tempRoot;
  });

  afterEach(async () => {
    mockProofLedger.maxShardBytes = 512;
    await rm(tempRoot, { recursive: true, force: true });
  });

  function makeSlimResult(summary: string): ToolExecutionResult {
    return {
      success: true,
      metadata: {
        browserComputerEvidenceCard: { status: 'captured', summary },
      },
    };
  }

  function persistSlim(sessionId: string, marker: string, createdAt: number) {
    const record = persistBrowserComputerProofFromResult(makeSlimResult(marker), {
      sessionId,
      toolName: 'screenshot',
      now: () => createdAt,
    });
    expect(record).not.toBeNull();
    return record!;
  }

  /** Shard paths oldest→newest, mirroring the reader's traversal order. */
  function shardPaths(): string[] {
    const active = getBrowserComputerProofLedgerPath();
    const shards: string[] = [];
    for (let suffix = mockProofLedger.keptShards - 1; suffix >= 1; suffix -= 1) {
      shards.push(`${active}.${suffix}`);
    }
    shards.push(active);
    return shards;
  }

  function allShardLines(): string[] {
    const lines: string[] = [];
    for (const shard of shardPaths()) {
      if (!existsSync(shard)) continue;
      lines.push(...readFileSync(shard, 'utf-8').split('\n').filter(Boolean));
    }
    return lines;
  }

  function shardIndexOf(marker: string): number {
    return shardPaths().findIndex((shard) => existsSync(shard) && readFileSync(shard, 'utf-8').includes(marker));
  }

  function summaries(records: ReturnType<typeof readBrowserComputerProofRecordsBySession>): string[] {
    return records.map((record) => String(record.summary));
  }

  it('rotates shards above the size threshold and drops shards beyond the kept count', async () => {
    const actual = await vi.importActual<typeof import('@shared/constants')>('@shared/constants');
    expect(actual.PROOF_LEDGER).toEqual({ MAX_SHARD_BYTES: 5 * 1024 * 1024, KEPT_SHARDS: 4 });

    persistSlim('session-rotate', 'proof-00', 1000);
    const active = getBrowserComputerProofLedgerPath();
    // Slim lines are uniform in size, so the measured first line fixes the per-shard capacity.
    const lineBytes = statSync(active).size;
    const perShard = Math.max(1, Math.floor(mockProofLedger.maxShardBytes / lineBytes));
    const total = 40;
    for (let i = 1; i < total; i += 1) {
      persistSlim('session-rotate', `proof-${String(i).padStart(2, '0')}`, 1000 + i);
    }

    expect(existsSync(active)).toBe(true);
    for (let suffix = 1; suffix < mockProofLedger.keptShards; suffix += 1) {
      expect(existsSync(`${active}.${suffix}`)).toBe(true);
    }
    // The shard beyond PROOF_LEDGER.KEPT_SHARDS is never created; the oldest shard dropped off.
    expect(existsSync(`${active}.${mockProofLedger.keptShards}`)).toBe(false);

    const expectedLines = (mockProofLedger.keptShards - 1) * perShard + (((total - 1) % perShard) + 1);
    const lines = allShardLines();
    expect(lines).toHaveLength(expectedLines);
    // Markers are zero-padded so `proof-00` cannot substring-match `proof-01` etc.
    for (let i = 0; i < total - expectedLines; i += 1) {
      expect(lines.some((line) => line.includes(`proof-${String(i).padStart(2, '0')}`))).toBe(false);
    }
    expect(summaries(readBrowserComputerProofRecordsBySession('session-rotate'))).toEqual(
      Array.from({ length: expectedLines }, (_, i) => `proof-${String(total - expectedLines + i).padStart(2, '0')}`),
    );
    expect(statSync(active).size).toBeLessThanOrEqual(mockProofLedger.maxShardBytes);
  });

  it('reads shards oldest-to-newest and keeps the most recent records across shards', () => {
    persistSlim('session-order', 'order-00', 2000);
    const active = getBrowserComputerProofLedgerPath();
    const lineBytes = statSync(active).size;
    const perShard = Math.max(1, Math.floor(mockProofLedger.maxShardBytes / lineBytes));
    const total = 3 * perShard + 1; // spreads records over >= 3 shards for any capacity
    for (let i = 1; i < total; i += 1) {
      persistSlim('session-order', `order-${String(i).padStart(2, '0')}`, 2000 + i);
    }

    const shardCount = shardPaths().filter((shard) => existsSync(shard)).length;
    expect(shardCount).toBeGreaterThanOrEqual(3);

    const expected = Array.from({ length: total }, (_, i) => `order-${String(i).padStart(2, '0')}`);
    expect(summaries(readBrowserComputerProofRecordsBySession('session-order'))).toEqual(expected);
    expect(summaries(readBrowserComputerProofRecordsBySession('session-order', 2))).toEqual(
      expected.slice(-2),
    );
    expect(summaries(readBrowserComputerProofRecordsBySession('session-order', 3))).toEqual(
      expected.slice(-3),
    );
  });

  it('applies an invalidation record in a later shard to earlier-shard records', () => {
    const sessionId = 'session-invalidate';
    const recordLine = (summary: string, createdAt: number, padBytes = 0) => `${JSON.stringify({
      schemaVersion: 1,
      id: `bc_proof_${createdAt}_${summary}`,
      sessionId,
      toolName: 'screenshot',
      createdAt,
      status: 'captured',
      summary,
      evidenceRefIds: [],
      targetKind: 'screenshot',
      proof: null,
      card: null,
      ...(padBytes > 0 ? { pad: 'x'.repeat(padBytes) } : {}),
    })}\n`;
    // Oversized first line forces the invalidation append into a fresh (later) shard.
    appendBrowserComputerProofLedgerLine(recordLine('early-1', 3000, mockProofLedger.maxShardBytes + 64));
    appendBrowserComputerProofLedgerLine(`${JSON.stringify({
      schemaVersion: 1,
      recordType: 'turn_checkout_evidence_invalidation',
      sessionId,
      createdAt: 9999,
      changedFilePaths: ['/tmp/changed.ts'],
      invalidateRunEvidence: true,
    })}\n`);
    appendBrowserComputerProofLedgerLine(recordLine('late-1', 3100));

    expect(shardIndexOf('early-1')).toBeLessThan(shardIndexOf('turn_checkout_evidence_invalidation'));

    const records = readBrowserComputerProofRecordsBySession(sessionId);
    expect(summaries(records)).toEqual(['early-1', 'late-1']);
    expect(records[0].evidenceInvalidatedAt).toBe(9999);
    expect(records[1].evidenceInvalidatedAt).toBeUndefined();
  });

  it('loses no lines when interleaved writers append during rotation', async () => {
    // A larger threshold lets every appended line survive on disk (no shard cap
    // deletion) while several rotations still happen mid-flight, so the exact
    // per-writer line count is assertable.
    mockProofLedger.maxShardBytes = 8 * 1024;
    const db = new Database(':memory:');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Parameters<typeof applySchema>[1];
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyIndexes(db);
    try {
      const otherLedger = path.join(tempRoot, 'other-ledger.jsonl');
      const proofLedger = getBrowserComputerProofLedgerPath();
      const count = 24;
      const pending: Promise<unknown>[] = [];
      for (let i = 0; i < count; i += 1) {
        // The other-ledger await keeps each invalidation in flight while the
        // synchronous proof persists interleave with its proof-ledger append.
        pending.push(invalidateSessionEvidence(db, 'session-concurrent', [`/tmp/file-${i}.ts`], {
          ledgerPaths: [otherLedger, proofLedger],
        }));
        persistSlim('session-concurrent', `conc-${String(i).padStart(2, '0')}`, 4000 + i);
      }
      await Promise.all(pending);

      // Rotation really happened while the writers were interleaved.
      expect(existsSync(`${proofLedger}.1`)).toBe(true);
      const lines = allShardLines();
      expect(lines).toHaveLength(count * 2);
      const invalidations = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((value) => value.recordType === 'turn_checkout_evidence_invalidation');
      expect(invalidations).toHaveLength(count);
      for (let i = 0; i < count; i += 1) {
        const marker = `conc-${String(i).padStart(2, '0')}`;
        expect(lines.filter((line) => line.includes(`"summary":"${marker}"`))).toHaveLength(1);
      }
      // Other ledger paths keep plain append behaviour: no shards, one line each.
      expect(readFileSync(otherLedger, 'utf-8').split('\n').filter(Boolean)).toHaveLength(count);
      expect(existsSync(`${otherLedger}.1`)).toBe(false);
    } finally {
      db.close();
    }
  });
});
