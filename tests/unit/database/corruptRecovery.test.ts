import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => Database,
  betterSqlite3CandidatePaths: () => [],
}));

vi.mock('../../../src/host/services/infra/dbBackup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/dbBackup')>();
  return { ...actual, copyBackupIntoPlace: vi.fn(actual.copyBackupIntoPlace) };
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { DatabaseIntegrityError } from '../../../src/host/services/core/database/sqliteErrors';
import {
  hasIntegrityFailedMarker,
  readUnrecoverableMarker,
  writeIntegrityFailedMarker,
} from '../../../src/host/services/core/database/integrityGate';
import { copyBackupIntoPlace } from '../../../src/host/services/infra/dbBackup';
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
import {
  getPersistenceHealth,
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';

const copyBackupMock = copyBackupIntoPlace as unknown as Mock;

const INSERT_SESSION_SQL = `INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;

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
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-backup', 'backup-point', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();

    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);
    const backupStamp = fs.statSync(`${dbPath}.backup-1`).mtimeMs;

    const extra = new Database(dbPath);
    extra.prepare(INSERT_SESSION_SQL).run('sess-after', 'after-backup', 'openai', 'gpt-5', dir, 2, 2);
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

  // ai-review 第二轮 Important 1:复制失败(如磁盘满)不可重试——
  // 重试会在空路径上 new Database 造空库顶替,用户历史看起来被清空。
  it('fails closed when the backup copy fails after isolation (never an empty-db retry)', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();
    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);
    corruptSqliteMaster(dbPath);

    copyBackupMock.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const failed = new DatabaseService(dir);
    await expect(failed.initialize()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(failed.initialize()).rejects.toMatchObject({
      code: SQLITE_INTEGRITY.RESTORE_FAILED,
    });
    expect(failed.isReady).toBe(false);
    // 空路径没有被顶成空库;好备份与隔离坏库都保留
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.backup-1`)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(true);
    // 不可恢复标记带着稳定 code;再次 initialize 走标记短路,仍是同一 code(不重试)
    expect(readUnrecoverableMarker(dir)?.code).toBe(SQLITE_INTEGRITY.RESTORE_FAILED);
    const retry = new DatabaseService(dir);
    await expect(retry.initialize()).rejects.toMatchObject({
      code: SQLITE_INTEGRITY.RESTORE_FAILED,
    });
    expect(fs.existsSync(dbPath)).toBe(false);
  }, 60_000);

  // ai-review 第二轮 Important 3:.integrity-failed 在 + Tier 1 通过 → 升级为尝试恢复
  //(方案档 §2.1 原意;Tier 2 全扫判决优先于 Tier 1 浅探针),成功恢复后标记才清。
  it('escalates to restore when .integrity-failed survives a Tier 1 pass', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-backup', 'backup-point', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();

    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);

    const extra = new Database(dbPath);
    extra.prepare(INSERT_SESSION_SQL).run('sess-after', 'after-backup', 'openai', 'gpt-5', dir, 2, 2);
    extra.pragma('wal_checkpoint(TRUNCATE)');
    extra.close();

    // 库文件本身没坏(Tier 1 会通过),但上次 Tier 2 quick_check 判过失败
    writeIntegrityFailedMarker(dir, Date.now());

    const svc = new DatabaseService(dir);
    await svc.initialize();
    expect(svc.getIntegrityOutcome().kind).toBe('recovered');
    const titles = svc.getDb()!
      .prepare('SELECT title FROM sessions ORDER BY created_at')
      .all() as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(['backup-point']);
    // 成功的恢复清标记
    expect(hasIntegrityFailedMarker(dir)).toBe(false);
    svc.close();
  }, 60_000);

  // 标记在 + Tier 1 通过 + 无备份:隔离(不删除)+ 不可恢复标记 + 稳定 code;
  // Tier 1 通过无权清 .integrity-failed。
  it('fails closed when .integrity-failed is set, Tier 1 passes, and no backup exists', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.close();
    writeIntegrityFailedMarker(dir, Date.now());

    const failed = new DatabaseService(dir);
    await expect(failed.initialize()).rejects.toMatchObject({
      code: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
    });
    expect(failed.isReady).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(true);
    expect(hasIntegrityFailedMarker(dir)).toBe(true);
    expect(readUnrecoverableMarker(dir)?.code).toBe(SQLITE_INTEGRITY.CORRUPT_NO_BACKUP);
  }, 60_000);
});
