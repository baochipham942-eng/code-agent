// Quickcheck 子进程真跑验证（hermetic，但**真的 spawn 了一个 node 进程**）。
// 钉 ADR-086 T3：子进程只收父进程解析好的**单个** better-sqlite3 绝对路径
// （bundle 态 = dist/native 清单 entry；源码态 = 包解析），单 require、零候选试探；
// 路径无法 require 时 exit 3 且 stderr 指名路径与来源；父进程解析失败不派子进程。
//
// ⚠️ 证据档位：hermetic-protocol（真 spawn 子进程 + 临时清单夹具）。
// 真 Dev 包（清单随包分发）未在本测试覆盖，需真机验。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-quickcheck-'));
const dbPath = path.join(dataDir, 'code-agent.db');
const logFile = path.join(dataDir, 'logs', `code-agent-${new Date().toISOString().split('T')[0]}.log`);

// getUserDataPath() 缓存首次结果，必须在 import 之前设好
process.env.CODE_AGENT_DATA_DIR = dataDir;

type Subprocess = typeof import('../../../src/host/services/infra/dbQuickCheckSubprocess');
let mod: Subprocess;

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

beforeAll(async () => {
  mod = await import('../../../src/host/services/infra/dbQuickCheckSubprocess');
  // better-sqlite3 是 CJS + native，走 createRequire 拿构造函数（vitest 的 ESM interop 拿不到）
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (p: string) => {
    exec(s: string): unknown;
    close(): void;
  };
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
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

describe('runQuickCheckInSubprocess (ADR-086 T3 单路径交接)', () => {
  it('源码模式：子进程加载包解析路径，quick_check ok', async () => {
    delete process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT;
    delete process.env.AGENT_NEO_RESOURCE_DIR;
    const outcome = await mod.runQuickCheckInSubprocess(dbPath);
    expect(outcome).toBe('ok');
    const line = await waitForLog(/native binding loaded from/);
    expect(line).toContain(repoBetterSqlite3);
  }, 60_000);

  it('bundle 夹具：子进程加载清单声明的路径，quick_check ok', async () => {
    const root = makeBundleFixture('ok');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3');
    const outcome = await mod.runQuickCheckInSubprocess(dbPath);
    expect(outcome).toBe('ok');
    const line = await waitForLog(/native binding loaded from/);
    expect(line).toContain(declared);
  }, 60_000);

  it('清单声明路径缺失：不派子进程，spawn-failed，错误指名模块与声明路径', async () => {
    const root = makeBundleFixture('missing');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3');
    const outcome = await mod.runQuickCheckInSubprocess(dbPath);
    expect(outcome).toBe('spawn-failed');
    const line = await waitForLog(/Database quick_check could not resolve better-sqlite3/);
    expect(line).toContain("module 'better-sqlite3' is declared at");
    expect(line).toContain(declared);
    // 没派子进程：日志里不应出现任何子进程 stderr 形状的行
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('native binding unresolved at');
  }, 60_000);

  it('子进程收到无法 require 的声明路径：exit 3，stderr 指名路径与来源', async () => {
    const root = makeBundleFixture('bogus');
    activateBundleEnv(root);
    const declared = path.join(root, 'dist', 'native', 'better-sqlite3.js');
    const outcome = await mod.runQuickCheckInSubprocess(dbPath);
    expect(outcome).toBe('spawn-failed');
    const line = await waitForLog(/better-sqlite3 native binding unresolved at/);
    expect(line).toContain(declared);
    expect(line).toContain('boom from bogus native entry');
    expect(line).toContain('native dep manifest');
  }, 60_000);
});
