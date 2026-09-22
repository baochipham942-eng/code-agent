import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const openFailure = vi.hoisted(() => ({ current: null as Error | null }));

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class extends Database {
    constructor(...args: ConstructorParameters<typeof Database>) {
      if (openFailure.current) {
        const err = openFailure.current;
        openFailure.current = null;
        throw err;
      }
      super(...args);
    }
  },
  betterSqlite3CandidatePaths: () => [],
}));

vi.mock('../../../src/host/services/infra/dbBackup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/dbBackup')>();
  return { ...actual, copyBackupIntoPlace: vi.fn(actual.copyBackupIntoPlace) };
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { DatabaseIntegrityError, DatabaseReadOnlyError } from '../../../src/host/services/core/database/sqliteErrors';
import { openReadOnlyDatabase } from '../../../src/host/services/core/database/readOnlyDegraded';
import { recordLedgerWriteError, getLedgerCorruptionStreak } from '../../../src/host/services/core/database/ledgerCorruptionMonitor';
import {
  hasIntegrityFailedMarker,
  readUnrecoverableMarker,
  writeIntegrityFailedMarker,
} from '../../../src/host/services/core/database/integrityGate';
import { copyBackupIntoPlace } from '../../../src/host/services/infra/dbBackup';
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
import { assembleDurableRun } from '../../../src/host/app/initializeDurableRun';
import { DurableRunPersistenceUnavailableError } from '../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import {
  applyDbIntegrityOutcome,
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
    recordLedgerWriteError.resetForTests();
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
    const err = await failed.initialize().catch((initErr: unknown) => initErr);
    expect(err).toBeInstanceOf(DatabaseIntegrityError);
    expect(err).toMatchObject({ code: SQLITE_INTEGRITY.RESTORE_FAILED });
    expect(failed.isReady).toBe(false);
    // 空路径没有被顶成空库;好备份与隔离坏库都保留
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.backup-1`)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(true);
    // 不可恢复标记带着稳定 code 落盘(自愈口子见下一条用例:有好备份+磁盘够 → 再试恢复)
    expect(readUnrecoverableMarker(dir)?.code).toBe(SQLITE_INTEGRITY.RESTORE_FAILED);
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

  // ai-review 第三轮:升级恢复必须手里先有恢复源。标记在 + Tier 1 通过 + 无好备份
  // → 不隔离还能读的库(隔离了就是永久内存模式,而 main 上同一个库还能用),
  // 留在当前库继续跑 + degraded(稳定 code),标记留给 Tier 2 复测定夺。
  it('keeps serving the readable db when .integrity-failed is set but no good backup exists', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-1', 'still-here', 'openai', 'gpt-5', dir, 1, 1);
    first.close();
    writeIntegrityFailedMarker(dir, Date.now());

    const svc = new DatabaseService(dir);
    await svc.initialize();
    expect(svc.getIntegrityOutcome()).toEqual({
      kind: 'degraded',
      reason: SQLITE_INTEGRITY.QUICK_CHECK_FAILED,
    });
    const titles = svc.getDb()!
      .prepare('SELECT title FROM sessions')
      .all() as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(['still-here']);
    svc.close();

    // 当前库原样保留:不隔离、不写不可恢复标记、失败标记留待 Tier 2 复测
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(false);
    expect(readUnrecoverableMarker(dir)).toBeNull();
    expect(hasIntegrityFailedMarker(dir)).toBe(true);
  }, 60_000);

  // ai-review 第四轮 Important 1:临时 IOERR 子码不许进隔离/恢复编排——
  // 原样抛可重试错误(_scheduleRetry 重开原库,main 基线行为),不隔离、不写任何标记。
  it('treats a transient SQLITE_IOERR_SHMMAP on open as retryable, never isolating', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-1', 'still-here', 'openai', 'gpt-5', dir, 1, 1);
    first.close();

    openFailure.current = Object.assign(new Error('disk I/O error'), {
      name: 'SqliteError',
      code: 'SQLITE_IOERR_SHMMAP',
    });
    const svc = new DatabaseService(dir);
    const openErr = await svc.initialize().catch((err: unknown) => err);
    // 原样抛可重试错误,不是 DatabaseIntegrityError(进不了隔离/恢复编排)
    expect(openErr).toMatchObject({ code: 'SQLITE_IOERR_SHMMAP' });
    expect(openErr).not.toBeInstanceOf(DatabaseIntegrityError);
    // 不隔离、不写标记、原库原样
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(false);
    expect(readUnrecoverableMarker(dir)).toBeNull();
    expect(hasIntegrityFailedMarker(dir)).toBe(false);
    // 可重试:重开原库成功,历史还在
    await svc.initialize();
    const titles = svc.getDb()!.prepare('SELECT title FROM sessions').all() as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(['still-here']);
    svc.close();
  }, 60_000);

  // ai-review 第四轮 Important 2:escalate preflight 空间不足 → 不隔离可读库、
  // degraded(DB_RESTORE_LOW_DISK)、不写标记保持可重试;空间恢复后下次启动自动恢复。
  it('does not isolate a readable db when disk is too low to restore, and heals later', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-backup', 'backup-point', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();
    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);
    writeIntegrityFailedMarker(dir, Date.now());

    const statfsSpy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1,
      bsize: 4096,
    } as unknown as fs.StatsFs);

    const lowDisk = new DatabaseService(dir);
    await lowDisk.initialize();
    expect(lowDisk.getIntegrityOutcome()).toEqual({
      kind: 'degraded',
      reason: SQLITE_INTEGRITY.RESTORE_LOW_DISK,
    });
    const lowTitles = lowDisk.getDb()!.prepare('SELECT title FROM sessions').all() as Array<{ title: string }>;
    expect(lowTitles.map((row) => row.title)).toEqual(['backup-point']);
    lowDisk.close();
    // 不隔离、不写标记、失败标记保留等空间恢复
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(false);
    expect(readUnrecoverableMarker(dir)).toBeNull();
    expect(hasIntegrityFailedMarker(dir)).toBe(true);

    // 空间恢复后:同一路径自动完成恢复并清标记
    statfsSpy.mockRestore();
    const healed = new DatabaseService(dir);
    await healed.initialize();
    expect(healed.getIntegrityOutcome().kind).toBe('recovered');
    expect(hasIntegrityFailedMarker(dir)).toBe(false);
    healed.close();
  }, 60_000);

  // .db-unrecoverable 自愈口子:手里重新有好备份且磁盘够 → 再试恢复,成功清标记
  it('heals a RESTORE_FAILED unrecoverable marker once a good backup and disk are available', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-backup', 'backup-point', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();
    fs.copyFileSync(dbPath, `${dbPath}.backup-1`);
    corruptSqliteMaster(dbPath);

    copyBackupMock.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const failed = new DatabaseService(dir);
    await expect(failed.initialize()).rejects.toMatchObject({ code: SQLITE_INTEGRITY.RESTORE_FAILED });
    expect(readUnrecoverableMarker(dir)?.code).toBe(SQLITE_INTEGRITY.RESTORE_FAILED);

    // 磁盘恢复(复制不再失败):同一次启动直接再试恢复,成功清标记
    const healed = new DatabaseService(dir);
    await healed.initialize();
    expect(healed.getIntegrityOutcome().kind).toBe('recovered');
    expect(readUnrecoverableMarker(dir)).toBeNull();
    const titles = healed.getDb()!
      .prepare('SELECT title FROM sessions ORDER BY created_at')
      .all() as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(['backup-point']);
    healed.close();
  }, 60_000);

  it('opens a WAL database readonly without checkpointing and refuses writes with a stable code', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 't.db');
    const writable = new Database(dbPath);
    writable.pragma('journal_mode = WAL');
    writable.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
    writable.prepare('INSERT INTO sessions VALUES (?, ?)').run('s1', 'keep-me');
    writable.pragma('wal_checkpoint(TRUNCATE)');
    writable.close();
    for (const suffix of ['-wal', '-shm'] as const) {
      try { fs.rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }

    const readonly = openReadOnlyDatabase(Database, dbPath);
    expect(readonly.prepare('SELECT title FROM sessions').all()).toEqual([{ title: 'keep-me' }]);
    expect(() => readonly.prepare('INSERT INTO sessions VALUES (?, ?)').run('s2', 'nope'))
      .toThrow(DatabaseReadOnlyError);
    try {
      readonly.exec('CREATE TABLE x (id TEXT)');
      throw new Error('exec should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseReadOnlyError);
      expect((err as DatabaseReadOnlyError).code).toBe(SQLITE_INTEGRITY.READONLY);
    }
    readonly.close();
  });

  // 刀3 融合点:无备份坏库不再直接进内存模式——先落 .db-unrecoverable(保自愈口子),
  // 再只读打开隔离副本给用户读历史;只读也打不开才抛 DB_CORRUPT_NO_BACKUP。
  // (打开期的 SQLITE_CORRUPT 用 nativeLoader 一次性注入,等价于 WAL 恢复期判坏。)
  it('keeps history readable and refuses writes when a corrupt db has no backup', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-history', 'readable-history', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();

    openFailure.current = Object.assign(new Error('database disk image is malformed'), {
      name: 'SqliteError',
      code: 'SQLITE_CORRUPT',
    });

    const degraded = new DatabaseService(dir);
    await degraded.initialize();
    expect(degraded.isReady).toBe(true);
    expect(degraded.isDegradedMode()).toBe(true);
    expect(degraded.getIntegrityOutcome()).toMatchObject({ kind: 'readonly' });
    // 坏库已隔离(永不删除)、不可恢复标记带着隔离路径落盘——下次启动自愈口子仍在
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('code-agent.db.corrupt-'))).toBe(true);
    expect(readUnrecoverableMarker(dir)?.code).toBe(SQLITE_INTEGRITY.CORRUPT_NO_BACKUP);

    expect(degraded.getSession('sess-history')?.title).toBe('readable-history');
    try {
      degraded.createSessionWithId('sess-new', {
        title: 'should-refuse',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
      });
      throw new Error('createSessionWithId should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseReadOnlyError);
      expect((err as DatabaseReadOnlyError).code).toBe(SQLITE_INTEGRITY.READONLY);
    }
    // 账本 append 仍 fail-safe 吞掉,且只读拒绝不计入 corruption 计数
    expect(() => degraded.appendUsageRecord({
      model: 'gpt-5', provider: 'openai', inputTokens: 1, outputTokens: 1, recordedAt: 2,
    })).not.toThrow();
    expect(getLedgerCorruptionStreak()).toBe(0);

    applyDbIntegrityOutcome(degraded.getIntegrityOutcome());
    expect(getPersistenceHealth()).toMatchObject({
      status: 'degraded',
      mode: 'database',
      durable: false,
      reason: SQLITE_INTEGRITY.READONLY,
    });
    degraded.close();
  }, 60_000);

  // 重启优先级:自愈恢复 > readonly > 内存模式。标记在 + 无备份 → 再进只读;
  // 一旦手里有了过 quick_check 的好备份,自愈恢复摘掉标记,不再只读。
  it('re-enters readonly on restart and self-heals once a good backup appears', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'code-agent.db');

    const first = new DatabaseService(dir);
    await first.initialize();
    first.getDb()!.prepare(INSERT_SESSION_SQL).run('sess-history', 'readable-history', 'openai', 'gpt-5', dir, 1, 1);
    first.getDb()!.pragma('wal_checkpoint(TRUNCATE)');
    first.close();

    openFailure.current = Object.assign(new Error('database disk image is malformed'), {
      name: 'SqliteError',
      code: 'SQLITE_CORRUPT',
    });
    const degraded = new DatabaseService(dir);
    await degraded.initialize();
    expect(degraded.isDegradedMode()).toBe(true);
    const isolatedPath = readUnrecoverableMarker(dir)?.isolatedPath;
    expect(isolatedPath).toBeTruthy();
    degraded.close();

    // 无备份重启:自愈口子找不到恢复源,回到只读而不是内存模式
    const again = new DatabaseService(dir);
    await again.initialize();
    expect(again.isDegradedMode()).toBe(true);
    expect(again.getSession('sess-history')?.title).toBe('readable-history');
    again.close();

    // 用户/运维补了一份好备份:同一路径下次启动自愈恢复、摘标记
    fs.copyFileSync(isolatedPath!, `${dbPath}.backup-1`);
    const healed = new DatabaseService(dir);
    await healed.initialize();
    expect(healed.isDegradedMode()).toBe(false);
    expect(healed.getIntegrityOutcome().kind).toBe('recovered');
    expect(readUnrecoverableMarker(dir)).toBeNull();
    expect(healed.getSession('sess-history')?.title).toBe('readable-history');
    healed.close();
  }, 60_000);

  it('installs a kernel that refuses run creation when persistence is degraded', async () => {
    const registry = new RunRegistry();
    const assembly = assembleDurableRun({
      registry,
      repository: null,
      persistenceUnavailable: true,
      ownerId: 'owner',
      processInstanceId: 'process',
      env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' },
    });
    expect(assembly.kernel).not.toBeNull();
    await expect(registry.waitForDurableKernel(1)).resolves.toBe(true);
    await expect(assembly.kernel!.createNativeRun({
      runId: 'run-degraded', sessionId: 'session-1', now: 1,
    })).rejects.toBeInstanceOf(DurableRunPersistenceUnavailableError);
    const runtime = await assembly.recover({ dataDir: '/tmp', now: 1 });
    expect(runtime.recoveryRuntime).toBeNull();
    await runtime.shutdown();
  });
});
