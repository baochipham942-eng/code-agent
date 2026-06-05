#!/usr/bin/env npx tsx
// ============================================================================
// 前端热更端到端冒烟（循环8）
// ============================================================================
// 起真实 dist/web/webServer.cjs，注入假的 renderer-cache/active/，验证：
//   1. active 健康   → serve 云端版（CLOUD marker）+ token 注入
//   2. active 移除   → 重启后回包内基线（builtin dist/renderer，无 CLOUD marker）
//   3. active 不健康 → 同样回包内基线（兜底铁律：绝不 serve 损坏前端）
//
// vitest pass ≠ 真实 webServer serve 正确（feedback_vitest_pass_does_not_imply_ui_mounted），
// 故本 smoke 走真实 .cjs 路径。设 CODE_AGENT_RENDERER_HOT_UPDATE=false 关后台拉取避免联网。

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

const repoRoot = process.cwd();
const CLOUD_MARKER = 'CLOUD-E2E-MARKER';

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

async function ensureBuilt(): Promise<void> {
  for (const rel of ['dist/web/webServer.cjs', 'dist/renderer/index.html']) {
    try {
      await access(path.join(repoRoot, rel), constants.R_OK);
    } catch {
      throw new Error(`${rel} missing. Run: npm run build:web && npm run build:renderer`);
    }
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('alloc port failed')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function extractToken(output: string, port: number): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const p = JSON.parse(line) as { port?: unknown; token?: unknown };
      if (p.port === port && typeof p.token === 'string' && p.token) return p.token;
    } catch { /* ignore */ }
  }
  return null;
}

async function startServer(dataDir: string): Promise<StartedServer> {
  const port = await getFreePort();
  const chunks: string[] = [];
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist/web/webServer.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_RENDERER_HOT_UPDATE: 'false', // 关后台拉取，避免联网
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => chunks.push(String(c)));
  child.stderr.on('data', (c) => chunks.push(String(c)));

  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: '',
    child,
    output: () => chunks.join('').slice(-40_000),
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webServer exited early (${server.child.exitCode})\n${server.output()}`);
    }
    const token = extractToken(server.output(), port);
    if (token) {
      try {
        const res = await fetch(`${server.baseUrl}/`);
        if (res.ok) {
          server.token = token;
          return server;
        }
      } catch { /* not ready */ }
    }
    await delay(200);
  }
  await stopServer(server).catch(() => undefined);
  throw new Error(`timed out waiting for webServer\n${server.output()}`);
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
}

async function fetchRoot(server: StartedServer): Promise<string> {
  const res = await fetch(`${server.baseUrl}/`);
  if (!res.ok) throw new Error(`GET / returned ${res.status}`);
  return res.text();
}

async function writeActive(dataDir: string, healthy: boolean): Promise<void> {
  const active = path.join(dataDir, 'renderer-cache', 'active');
  await mkdir(path.join(active, 'assets'), { recursive: true });
  await writeFile(
    path.join(active, '.bundle-meta.json'),
    JSON.stringify({ version: '99.99.99', contentHash: 'e2ehash' }),
    'utf8',
  );
  if (healthy) {
    await writeFile(
      path.join(active, 'index.html'),
      `<!doctype html><html><head></head><body>${CLOUD_MARKER}</body></html>`,
      'utf8',
    );
  }
  // 不健康场景：故意不写 index.html
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  await ensureBuilt();
  const results: string[] = [];

  // ── 场景1：active 健康 → serve 云端版 + token ───────────────────
  {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rb-e2e-active-'));
    await writeActive(dataDir, true);
    const server = await startServer(dataDir);
    try {
      const html = await fetchRoot(server);
      assert(html.includes(CLOUD_MARKER), '场景1 应 serve 云端 active 版（含 CLOUD marker）');
      assert(html.includes(`window.__CODE_AGENT_TOKEN__="${server.token}"`), '场景1 应注入 token');
      results.push('✅ 场景1 active 健康 → serve 云端版 + token 注入');
    } finally {
      await stopServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  // ── 场景2：无 active → 回包内基线（builtin，无 CLOUD marker）───────
  {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rb-e2e-builtin-'));
    const server = await startServer(dataDir);
    try {
      const html = await fetchRoot(server);
      assert(!html.includes(CLOUD_MARKER), '场景2 不应含 CLOUD marker（应 serve builtin）');
      assert(html.includes('<div id="root">'), '场景2 builtin index 应含 #root 挂载点');
      assert(html.includes(`window.__CODE_AGENT_TOKEN__="${server.token}"`), '场景2 应注入 token');
      results.push('✅ 场景2 无 active → 回包内基线 + token 注入');
    } finally {
      await stopServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  // ── 场景3：active 不健康（缺 index.html）→ 兜底回包内基线 ──────────
  {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rb-e2e-unhealthy-'));
    await writeActive(dataDir, false);
    const server = await startServer(dataDir);
    try {
      const html = await fetchRoot(server);
      assert(!html.includes(CLOUD_MARKER), '场景3 不应含 CLOUD marker');
      assert(html.includes('<div id="root">'), '场景3 应回 builtin（含 #root）');
      results.push('✅ 场景3 active 不健康 → 兜底回包内基线');
    } finally {
      await stopServer(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  console.log('\n=== renderer hot-update E2E smoke ===');
  for (const r of results) console.log(r);
  console.log('\n🎉 全部场景通过');
}

main().catch((err) => {
  console.error('\n❌ smoke 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
