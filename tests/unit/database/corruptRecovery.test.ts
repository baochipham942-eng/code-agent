import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => Database,
  betterSqlite3CandidatePaths: () => [],
}));

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { DatabaseIntegrityError } from '../../../src/host/services/core/database/sqliteErrors';
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
import {
  getPersistenceHealth,
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';

function corruptSqliteMaster(dbPath: string): void {
  const buf = fs.readFileSync(dbPath);
  const start = Math.min(120, buf.length);
  for (let i = start; i < Math.min(start + 400, buf.length); i += 1) {
    buf[i] ^= 0xff;
  }
  fs.writeFileSync(dbPath, buf);
}

describe('corrupt database recovery during init', () => {
  const dirs: string[] = [];
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    setDbAvailable(false, new Error('test reset'));
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-corrupt-recovery-'));
    dirs.push(dir);
    process.env.CODE_AGENT_DATA_DIR = dir;
    return dir;
  }

  it('restores from a good backup and keeps the isolated corrupt file', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(
      `INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess-backup', 'backup-point', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();

    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);
    const backupStamp = fs.statSync(`${dbPath}.backup-1`).mtimeMs;

    const extra = new Database(dbPath);
    extra.prepare(
      `INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess-after', 'after-backup', 'openai', 'gpt-5', dir, 2, 2);
    extra.pragma('wal_checkpoint(TRUNCATE)');
    extra.close();

    corruptSqliteMaster(dbPath);

    const recovered = new DatabaseService(dir);
    await recovered.initialize();
    const titles = recovered.getDb()!
      .prepare('SELECT title FROM sessions ORDER BY created_at')
      .all() as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(['backup-point']);
    expect(recovered.getIntegrityOutcome()).toMatchObject({
      kind: 'recovered',
      backupTakenAt: backupStamp,
    });
    recovered.close();

    const isolated = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(isolated.length).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);
  }, 60_000);

  it('isolates a corrupt db with no backup and stays on the memory path', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.close();
    corruptSqliteMaster(dbPath);

    const failed = new DatabaseService(dir);
    await expect(failed.initialize()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(failed.initialize()).rejects.toMatchObject({
      code: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
    });
    expect(failed.isReady).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    const isolated = fs.readdirSync(dir).filter((name) => name.startsWith('code-agent.db.corrupt-'));
    expect(isolated.length).toBeGreaterThan(0);

    setDbAvailable(false, new DatabaseIntegrityError(SQLITE_INTEGRITY.CORRUPT_NO_BACKUP));
    expect(getPersistenceHealth()).toMatchObject({
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      reason: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
    });
  }, 60_000);
});
