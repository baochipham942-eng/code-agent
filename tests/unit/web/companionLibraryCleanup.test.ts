import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, logger, default: logger };
});

const getDb = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb }),
}));

import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { CompanionLibraryService } from '../../../src/host/services/companion/CompanionLibraryService';

describe('companion library cleanup rejection handling', () => {
  it('createApp attaches a rejection handler to library.cleanup()', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/web/app.ts'), 'utf8');
    expect(src).toMatch(/services\.library\.cleanup\(\)\s*\.catch\s*\(/);
    expect(src).not.toMatch(/void services\.library\.cleanup\(\);/);
  });

  it('cleanup logs and resolves when the cleanup query itself throws', async () => {
    warn.mockClear();
    getDb.mockReturnValue({
      prepare: () => { throw new Error('injected-cleanup-prepare'); },
    });
    const db = new Database(':memory:');
    try {
      const gateway = new CompanionGateway(db);
      const library = new CompanionLibraryService(gateway, () => false);
      await expect(library.cleanup()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'Companion deleted-session cleanup unavailable',
        expect.objectContaining({ message: 'injected-cleanup-prepare' }),
      );
    } finally {
      db.close();
    }
  });
});
