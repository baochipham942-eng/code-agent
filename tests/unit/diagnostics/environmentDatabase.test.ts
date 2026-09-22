import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '',
  columns: ['id', 'title', 'is_deleted', 'is_archived'],
  degraded: false,
  ledgerCorrupt: 0,
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => state.dataDir,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        all: () => state.columns.map((name) => ({ name })),
      }),
    }),
    isDegradedMode: () => state.degraded,
  }),
}));

vi.mock('../../../src/host/services/core/database/ledgerCorruptionMonitor', () => ({
  getLedgerCorruptionStreak: () => state.ledgerCorrupt,
}));

import { checkDatabase } from '../../../src/host/diagnostics/checks/environment';

describe('database environment diagnostics', () => {
  afterEach(() => {
    if (state.dataDir) fs.rmSync(state.dataDir, { recursive: true, force: true });
    state.dataDir = '';
    state.columns = ['id', 'title', 'is_deleted', 'is_archived'];
    state.degraded = false;
    state.ledgerCorrupt = 0;
  });

  it('fails with the exact missing sessions columns', async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-db-'));
    fs.writeFileSync(path.join(state.dataDir, 'code-agent.db'), 'sqlite');
    state.columns = ['id', 'title', 'is_deleted'];

    await expect(checkDatabase()).resolves.toMatchObject({
      status: 'fail',
      message: 'sessions schema missing: is_archived',
    });
  });

  it('warns on read-only degraded mode and ledger corruption streak', async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-db-'));
    fs.writeFileSync(path.join(state.dataDir, 'code-agent.db'), 'sqlite');
    state.degraded = true;
    state.ledgerCorrupt = 3;

    const item = await checkDatabase();
    expect(item.status).toBe('warn');
    expect(item.message).toContain('mode readonly');
    expect(item.message).toContain('ledger_corrupt 3');
    expect(item.suggestion).toContain('read-only');
  });
});
