// VACUUM 子进程的真跑验证（hermetic，但**真的 spawn 了一个 node 进程**）：
// 单纯 mock spawn 验不出本改动最容易挂的那件事 —— 子进程能不能在另一个进程里
// 拿到 better-sqlite3 的 native binding。这里用临时库真跑一遍整条链。
//
// ⚠️ 证据档位：dev 态（binding 在 node_modules）。打包态 binding 在
// dist/native/better-sqlite3/，候选清单同源但**本测试覆盖不到**，需真机 Dev 包验。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-vacuum-'));
const dbPath = path.join(dataDir, 'code-agent.db');
const lockPath = path.join(dataDir, '.vacuum-running');

// getUserDataPath() 缓存首次结果，必须在 import 之前设好
process.env.CODE_AGENT_DATA_DIR = dataDir;

type Subprocess = typeof import('../../../src/host/services/infra/dbVacuumSubprocess');
let mod: Subprocess;

beforeAll(async () => {
  mod = await import('../../../src/host/services/infra/dbVacuumSubprocess');
  // better-sqlite3 是 CJS + native，走 createRequire 拿构造函数（vitest 的 ESM interop 拿不到）
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (p: string) => {
    pragma(s: string): unknown;
    exec(s: string): unknown;
    prepare(s: string): { run(...a: unknown[]): unknown };
    transaction(fn: () => void): () => void;
    close(): void;
  };
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE junk (id INTEGER PRIMARY KEY, blob TEXT)');
  const insert = db.prepare('INSERT INTO junk (blob) VALUES (?)');
  const fill = db.transaction(() => {
    for (let i = 0; i < 4000; i++) insert.run('x'.repeat(512));
  });
  fill();
  db.exec('DELETE FROM junk');
  db.close();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('runVacuumInSubprocess', () => {
  it('在子进程里真跑 VACUUM 并回收空间', async () => {
    const before = fs.statSync(dbPath).size;
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('completed');
    expect(fs.statSync(dbPath).size).toBeLessThan(before);
    // 子进程干净 close() 过：wal/shm 不应残留
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    // 锁必须被清掉，否则下次启动永远跳过
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 60_000);

  it('已有活着的 VACUUM 进程时跳过', async () => {
    fs.writeFileSync(lockPath, String(process.pid), 'utf8'); // 自己一定活着
    try {
      expect(await mod.runVacuumInSubprocess(dbPath)).toBe('skipped-already-running');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it('陈旧锁（进程已死）不阻塞 VACUUM', async () => {
    // pid 1 之外找一个几乎不可能存在的 pid：写一个死 pid
    fs.writeFileSync(lockPath, '2147483646', 'utf8');
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('completed');
  }, 60_000);
});
