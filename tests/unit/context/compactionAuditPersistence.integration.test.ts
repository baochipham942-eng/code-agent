import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Session } from '../../../src/shared/contract';
import type { CLIDatabaseService } from '../../../src/cli/database';

const integrationMocks = vi.hoisted(() => ({
  sink: null as (CLIDatabaseService & { isReady: boolean }) | null,
  summary: 'Automatic compaction retained the agreed migration context.',
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => integrationMocks.sink,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createLogger: () => logger,
    logger,
  };
});

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarizeWithMetadata: vi.fn(async () => ({
    summary: integrationMocks.summary,
    metadata: {
      provider: 'test-provider',
      model: 'test-compactor',
      useMainModel: false,
    },
  })),
}));

vi.mock('../../../src/host/tools/dataFingerprint', () => ({
  dataFingerprintStore: { toSummary: vi.fn(() => '') },
}));

vi.mock('../../../src/host/tools/fileReadTracker', () => ({
  fileReadTracker: { clear: vi.fn(), getRecentFiles: vi.fn(() => []) },
}));

import { initCLIDatabase } from '../../../src/cli/database';
import { debugCommand } from '../../../src/cli/commands/debug';
import { compactMessagesWithSummary } from '../../../src/host/context/compactionService';

describe('automatic compaction audit persistence', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'n-compactsnap-'));
  const sessionId = 'session-auto-compaction-audit';
  let db: CLIDatabaseService;

  beforeAll(async () => {
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    db = await initCLIDatabase();
    Object.defineProperty(db, 'isReady', { value: true, configurable: true });
    integrationMocks.sink = db as CLIDatabaseService & { isReady: boolean };
    const now = 1_780_000_000_000;
    db.createSession({
      id: sessionId,
      title: 'Automatic compaction audit integration',
      modelConfig: { provider: 'openai', model: 'test-model' },
      workingDirectory: dataDir,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
    } as Session);
  });

  afterAll(() => {
    integrationMocks.sink = null;
    db.close();
    delete process.env.CODE_AGENT_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes an auto-threshold snapshot and exposes it through debug compact diff', async () => {
    const longContext = 'Historical migration context remains authoritative. '.repeat(1_600);
    const messages: Message[] = [
      { id: 'm1', role: 'system', content: longContext, timestamp: 1 },
      { id: 'm2', role: 'assistant', content: longContext, timestamp: 2 },
      { id: 'm3', role: 'assistant', content: longContext, timestamp: 3 },
      { id: 'm4', role: 'assistant', content: 'recent answer', timestamp: 4 },
    ];

    const result = await compactMessagesWithSummary({
      sessionId,
      source: 'auto_threshold',
      messages,
      preserveRecentCount: 1,
      usagePercent: 0.91,
      now: 1_780_000_000_100,
    });

    expect(result.success).toBe(true);
    const rows = db.listCompactionSnapshots(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      strategy: 'auto_threshold',
      preMessageCount: 4,
      postMessageCount: 2,
      usagePercent: 0.91,
      postMessagesSummary: expect.objectContaining({
        type: 'compact_messages_with_summary_audit',
        success: true,
      }),
    });

    const log = vi.spyOn(console, 'log');
    try {
      await debugCommand.parseAsync(['node', 'debug', 'compact', 'diff', sessionId]);
      const output = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(output).toContain(`Compactions of ${sessionId} (1 total):`);
      expect(output).toContain('auto_threshold');
    } finally {
      log.mockRestore();
    }
  });
});
