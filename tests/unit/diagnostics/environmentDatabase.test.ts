import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataDir: '',
  columns: ['id', 'title', 'is_deleted', 'is_archived'],
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
  }),
}));

import { checkDatabase } from '../../../src/host/diagnostics/checks/environment';

describe('database environment diagnostics', () => {
  afterEach(() => {
    if (state.dataDir) fs.rmSync(state.dataDir, { recursive: true, force: true });
    state.dataDir = '';
    state.columns = ['id', 'title', 'is_deleted', 'is_archived'];
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
});
