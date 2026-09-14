import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  findLatestGoodBackup,
  isolateCorruptDatabase,
  rotateDatabaseBackup,
} from '../../../src/host/services/infra/dbBackup';

const { backupSlotPath, shouldRunBackup } = rotateDatabaseBackup;
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
import { evaluateQuickCheck } from '../../../src/host/services/core/database/integrityGate';

const NOW = 1_800_000_000_000;

describe('shouldRunBackup', () => {
  it('runs when never backed up, skips inside the throttle window', () => {
    expect(shouldRunBackup(NOW, null)).toBe(true);
    expect(shouldRunBackup(NOW, NOW - SQLITE_INTEGRITY.BACKUP_MIN_INTERVAL_MS - 1)).toBe(true);
    expect(shouldRunBackup(NOW, NOW - 1000)).toBe(false);
  });
});

describe('rotateDatabaseBackup', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-db-backup-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'code-agent.db');
    fs.writeFileSync(dbPath, 'main-db');
    return dbPath;
  }

  it('keeps only BACKUP_KEEP slots, with backup-1 as the newest', async () => {
    const dbPath = tmpDb();
    let serial = 0;
    const backupTo = async (dest: string) => {
      serial += 1;
      fs.writeFileSync(dest, `copy-${serial}`);
    };

    expect(await rotateDatabaseBackup({
      dbPath, now: NOW, force: true, backupTo, hasFreeSpace: async () => ({ ok: true, detail: 'ok' }),
    })).toBe('completed');
    expect(await rotateDatabaseBackup({
      dbPath, now: NOW + 1, force: true, backupTo, hasFreeSpace: async () => ({ ok: true, detail: 'ok' }),
    })).toBe('completed');
    expect(await rotateDatabaseBackup({
      dbPath, now: NOW + 2, force: true, backupTo, hasFreeSpace: async () => ({ ok: true, detail: 'ok' }),
    })).toBe('completed');

    expect(fs.readFileSync(backupSlotPath(dbPath, 1), 'utf8')).toBe('copy-3');
    expect(fs.readFileSync(backupSlotPath(dbPath, 2), 'utf8')).toBe('copy-2');
    expect(fs.existsSync(backupSlotPath(dbPath, 3))).toBe(false);
  });

  it('honors the throttle marker unless force is set', async () => {
    const dbPath = tmpDb();
    const backupTo = async (dest: string) => {
      fs.writeFileSync(dest, 'copy');
    };
    const result = await rotateDatabaseBackup({
      dbPath,
      now: NOW,
      backupTo,
      readLastBackupAt: () => NOW - 1000,
      writeLastBackupAt: () => undefined,
      hasFreeSpace: async () => ({ ok: true, detail: 'ok' }),
    });
    expect(result).toBe('not-due');
    expect(fs.existsSync(backupSlotPath(dbPath, 1))).toBe(false);
  });

  it('skips when disk precheck says there is not enough space', async () => {
    const dbPath = tmpDb();
    const result = await rotateDatabaseBackup({
      dbPath,
      now: NOW,
      force: true,
      backupTo: async () => {
        throw new Error('should not backup');
      },
      hasFreeSpace: async () => ({ ok: false, detail: 'full' }),
    });
    expect(result).toBe('skipped-low-disk');
  });
});

describe('findLatestGoodBackup', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a backup whose quick_check fails and adopts the next good slot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-backup-reject-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'code-agent.db');
    const goodPath = path.join(dir, 'good.db');
    const good = new Database(goodPath);
    good.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
    good.close();
    fs.copyFileSync(goodPath, backupSlotPath(dbPath, 2));
    fs.writeFileSync(backupSlotPath(dbPath, 1), Buffer.alloc(4096, 0xff));

    const isGood = (candidate: string): boolean => {
      try {
        const db = new Database(candidate, { readonly: true, fileMustExist: true });
        try {
          return evaluateQuickCheck(db).ok;
        } finally {
          db.close();
        }
      } catch {
        return false;
      }
    };
    expect(isGood(backupSlotPath(dbPath, 1))).toBe(false);
    expect(isGood(backupSlotPath(dbPath, 2))).toBe(true);
    expect(findLatestGoodBackup(dbPath, isGood)?.path).toBe(backupSlotPath(dbPath, 2));
  });
});

describe('isolateCorruptDatabase', () => {
  it('renames db/wal/shm and never deletes them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-isolate-'));
    try {
      const dbPath = path.join(dir, 'code-agent.db');
      fs.writeFileSync(dbPath, 'db');
      fs.writeFileSync(`${dbPath}-wal`, 'wal');
      fs.writeFileSync(`${dbPath}-shm`, 'shm');
      const isolated = isolateCorruptDatabase(dbPath, 123);
      expect(isolated).toBe(`${dbPath}.corrupt-123`);
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.readFileSync(`${isolated}`, 'utf8')).toBe('db');
      expect(fs.readFileSync(`${isolated}-wal`, 'utf8')).toBe('wal');
      expect(fs.readFileSync(`${isolated}-shm`, 'utf8')).toBe('shm');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
