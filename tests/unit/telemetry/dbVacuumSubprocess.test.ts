// VACUUM 子进程的真跑验证（hermetic，但**真的 spawn 了一个 node 进程**）：
// 单纯 mock spawn 验不出本改动最容易挂的那件事 —— 子进程能不能在另一个进程里
// 拿到 better-sqlite3 的 native binding。这里用临时库真跑一遍整条链。
//
// ADR-086 T3 之后子进程不再持候选清单：父进程解析**单个**绝对路径
// （bundle 态 = dist/native 清单 entry；源码态 = 包解析）传入，子进程单 require。
// 下面的 bundle 夹具用临时 manifest.json + 软链钉这条交接。
//
// ⚠️ 证据档位：hermetic-protocol（真 spawn 子进程 + 临时清单夹具）。
// 真 Dev 包（清单随包分发）未在本测试覆盖，需真机验。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-vacuum-'));
const dbPath = path.join(dataDir, 'code-agent.db');
const lockPath = path.join(dataDir, '.vacuum-running');
const logFile = path.join(dataDir, 'logs', `code-agent-${new Date().toISOString().split('T')[0]}.log`);

// getUserDataPath() 缓存首次结果，必须在 import 之前设好
process.env.CODE_AGENT_DATA_DIR = dataDir;

// 仓库 node_modules 里的真 better-sqlite3（bundle 夹具把它当作清单声明的 entry）
const repoBetterSqlite3 = path.dirname(
  path.dirname(createRequire(import.meta.url).resolve('better-sqlite3')),
);
const bundleRoots: string[] = [];
const savedRuntimeRoot = process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT;
const savedResourceDir = process.env.AGENT_NEO_RESOURCE_DIR;

/** 造一个 bundle 形状的临时 runtime root（dist/native/manifest.json） */
function makeBundleFixture(mode: 'ok' | 'missing' | 'bogus'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-native-manifest-'));
  bundleRoots.push(root);
  const nativeDir = path.join(root, 'dist', 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  let entry = 'dist/native/better-sqlite3';
  if (mode === 'ok') {
    // 清单声明路径存在且可 require：软链到仓库真 node_modules/better-sqlite3
    fs.symlinkSync(repoBetterSqlite3, path.join(nativeDir, 'better-sqlite3'), 'dir');
  } else if (mode === 'bogus') {
    // 声明路径存在但 require 必炸：钉子进程 exit 3 线
    entry = 'dist/native/better-sqlite3.js';
    fs.writeFileSync(
      path.join(nativeDir, 'better-sqlite3.js'),
      "throw new Error('boom from bogus native entry');\n",
    );
  }
  // 'missing'：只声明不落盘
  fs.writeFileSync(
    path.join(nativeDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_native_dep_manifest',
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      modules: { 'better-sqlite3': { kind: 'node-module', entry } },
    }),
  );
  return root;
}

function activateBundleEnv(root: string): void {
  process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT = root;
  process.env.AGENT_NEO_RESOURCE_DIR = root;
}

/** 轮询日志文件直到出现匹配行（文件 sink 是异步 write stream） */
async function waitForLog(match: RegExp, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let content = '';
    try {
      content = fs.readFileSync(logFile, 'utf8');
    } catch {
      /* 日志文件还没建 */
    }
    const line = content.split('\n').filter((l) => match.test(l)).pop();
    if (line) return line;
    if (Date.now() > deadline) {
      throw new Error(`log line ${match} not found within ${timeoutMs}ms; tail:\n${content.split('\n').slice(-5).join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

afterEach(() => {
  if (savedRuntimeRoot === undefined) delete process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT;
  else process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT = savedRuntimeRoot;
  if (savedResourceDir === undefined) delete process.env.AGENT_NEO_RESOURCE_DIR;
  else process.env.AGENT_NEO_RESOURCE_DIR = savedResourceDir;
});

afterAll(() => {
  for (const root of bundleRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('runVacuumInSubprocess', () => {
  it('源码模式：在子进程里真跑 VACUUM 并回收空间', async () => {
    const before = fs.statSync(dbPath).size;
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('completed');
    // 子进程 stderr 里的加载行随 ok 日志落盘：源码模式= 包解析路径
    const line = await waitForLog(/native binding loaded from/);
    expect(line).toContain(repoBetterSqlite3);
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

describe('runVacuumInSubprocess (ADR-086 T3 单路径交接)', () => {
  it('bundle 夹具：子进程加载清单声明的路径，VACUUM completed', async () => {
    const root = makeBundleFixture('ok');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3');
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('completed');
    const line = await waitForLog(/native binding loaded from/);
    expect(line).toContain(declared);
  }, 60_000);

  it('清单声明路径缺失：不派子进程，failed，错误指名模块与声明路径', async () => {
    const root = makeBundleFixture('missing');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3');
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('failed');
    const line = await waitForLog(/Database VACUUM could not resolve better-sqlite3/);
    expect(line).toContain("module 'better-sqlite3' is declared at");
    expect(line).toContain(declared);
    // 没派子进程：日志里不应出现任何子进程 stderr 形状的行
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('native binding unresolved at');
  }, 60_000);

  it('子进程收到无法 require 的声明路径：exit 3，stderr 指名路径与来源', async () => {
    const root = makeBundleFixture('bogus');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3.js');
    const outcome = await mod.runVacuumInSubprocess(dbPath);
    expect(outcome).toBe('failed');
    const line = await waitForLog(/better-sqlite3 native binding unresolved at/);
    expect(line).toContain(declared);
    expect(line).toContain('boom from bogus native entry');
    expect(line).toContain('native dep manifest');
  }, 60_000);
});
