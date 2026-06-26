/**
 * Smoke — multi-agent BrowserPool isolation with REAL chromium launch.
 *
 * 验证 BrowserPool 拿到的 per-agent BrowserService 真的：
 *   1. 不同实例 + 不同 profileDir
 *   2. 真 launch chromium 后 cookies/localStorage 隔离
 *   3. 同 agentId 二次 acquire 命中缓存（但本测试每次 acquire 后会 close 不重入）
 *
 * 跑法：npm run test:smoke -- tests/smoke/multiAgentBrowserIsolation.smoke.test.ts
 *（smoke 测试已从默认 npm test 中隔离 —— 会真实操作桌面/启动真实进程）
 * 依赖：playwright bundled chromium 已就位（~/Library/Caches/ms-playwright/chromium-*）
 *
 * Timeout 90s — 包括 chromium cold launch（~2s × 2 + cookie roundtrip）。
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { BrowserPool } from '../../src/host/services/infra/browserPool';
import { browserService as defaultBrowserService } from '../../src/host/services/infra/browserService';

const TIMEOUT_MS = 90_000;

describe('multi-agent BrowserPool isolation (real chromium)', () => {
  const pool = new BrowserPool(4, defaultBrowserService);
  const agentA = pool.acquire('smoke-agent-a');
  const agentB = pool.acquire('smoke-agent-b');
  let server: Server | undefined;
  let smokeOrigin = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>browser isolation smoke</h1></body></html>');
    });

    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    smokeOrigin = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await agentA.close().catch(() => undefined);
    await agentB.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  });

  it('grants distinct BrowserService instances and profileDirs per agent', () => {
    expect(agentA).not.toBe(agentB);
    const stateA = agentA.getSessionState();
    const stateB = agentB.getSessionState();
    expect(stateA.profileId).not.toBe(stateB.profileId);
    expect(stateA.profileDir).not.toBe(stateB.profileDir);
    expect(stateA.profileId).toContain('smoke-agent-a');
    expect(stateB.profileId).toContain('smoke-agent-b');
    console.log('[smoke] agent-a profileDir:', stateA.profileDir);
    console.log('[smoke] agent-b profileDir:', stateB.profileDir);
  });

  it(
    'isolates cookies and localStorage between agents through real chromium launches',
    async () => {
      // agent-a — launch, write cookie + localStorage on data: URL origin, close
      await agentA.launch({ leaseOwner: 'smoke-agent-a' });
      const tabIdA = await agentA.newTab('about:blank');
      await agentA.navigate(smokeOrigin, tabIdA);
      await agentA.runScript<unknown>(
        `document.cookie = "smoke_marker=agent_a; path=/; max-age=3600"; ` +
        `localStorage.setItem("smoke_ls", "from_a"); ` +
        `void 0`,
        tabIdA,
      );
      const aCookies = await agentA.runScript<string>('document.cookie', tabIdA);
      const aLs = await agentA.runScript<string | null>('localStorage.getItem("smoke_ls")', tabIdA);
      console.log('[smoke] agent-a cookies after write:', aCookies);
      console.log('[smoke] agent-a localStorage:', aLs);
      expect(aCookies).toContain('smoke_marker=agent_a');
      expect(aLs).toBe('from_a');
      await agentA.close();

      // agent-b — launch on independent profileDir, navigate same origin, expect NO marker
      await agentB.launch({ leaseOwner: 'smoke-agent-b' });
      const tabIdB = await agentB.newTab('about:blank');
      await agentB.navigate(smokeOrigin, tabIdB);
      const bCookies = await agentB.runScript<string>('document.cookie', tabIdB);
      const bLs = await agentB.runScript<string | null>('localStorage.getItem("smoke_ls")', tabIdB);
      console.log('[smoke] agent-b cookies (should be empty/no marker):', bCookies);
      console.log('[smoke] agent-b localStorage (should be null):', bLs);
      expect(bCookies).not.toContain('smoke_marker=agent_a');
      expect(bLs).toBeNull();
      await agentB.close();
    },
    TIMEOUT_MS,
  );
});
