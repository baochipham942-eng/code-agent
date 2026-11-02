/**
 * Smoke — N-BROWSER-KEEP-RESULT-PAGE 真浏览器端到端（真 Playwright Chromium + 本地
 * fixture 表单站，全程过 ManagedBrowserProviderAdapter / keptBrowserRegistry，与生产同一条链路）：
 *
 *   1. agent run：开搜索页 → 开表单页 → 填写并提交 → keep_result_page（关掉中间页）
 *   2. run 结束（runtime.endRun）→ 结果窗仍活着（不随 binding 清理关闭）
 *   3. 闲置回收（lease 到期关窗）→ 临时 profile 目录删除、池无泄漏、条目翻 closed（URL 留存）
 *
 * 跑法：npx vitest run --config vitest.smoke.config.ts tests/smoke/browserKeepResultPage.smoke.test.ts
 * 依赖：playwright bundled chromium 已就位。
 */

import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool } from '../../src/host/services/infra/browserPool';
import { BrowserService } from '../../src/host/services/infra/browserService';
import { RunRegistry } from '../../src/host/runtime/runRegistry';
import {
  ManagedBrowserProviderAdapter,
} from '../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  KeptBrowserRegistry,
} from '../../src/host/services/surfaceExecution/keptBrowserRegistry';
import { executeKeepResultPage } from '../../src/host/tools/vision/browserKeepResultPage';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../src/shared/contract/surfaceExecution';

const TIMEOUT_MS = 120_000;

const FORM_PAGE = `<!doctype html><html><head><title>smoke keep form</title></head><body>
<h1>smoke keep result form</h1>
<form id="f"><input id="q" value=""><button id="submit" type="submit">Submit</button></form>
<div id="result" style="display:none"></div>
<input id="notes" style="display:none">
<script>
document.getElementById('f').addEventListener('submit', function (event) {
  event.preventDefault();
  document.getElementById('result').textContent = 'Submitted: ' + document.getElementById('q').value;
  document.getElementById('result').style.display = 'block';
  document.getElementById('notes').style.display = 'block';
});
</script>
</body></html>`;

const OTHER_PAGE = `<!doctype html><html><head><title>smoke intermediate</title></head><body>
<h1>intermediate search page</h1></body></html>`;

describe('browser keep_result_page end-to-end (real chromium)', () => {
  let server: Server | undefined;
  let formUrl = '';
  let otherUrl = '';
  let pool: BrowserPool;
  let keptRegistry: KeptBrowserRegistry;
  let runtime: SurfaceExecutionRuntime;
  let registry: RunRegistry;
  let adapter: ManagedBrowserProviderAdapter;
  const agentIdentity: SurfaceRuntimeIdentityV1 = {
    conversationId: 'smoke-keep-conversation',
    runId: 'smoke-keep-run-a',
    agentId: 'smoke-keep-agent',
  };

  beforeAll(() => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/other' ? OTHER_PAGE : FORM_PAGE);
    });
    pool = new BrowserPool(4, new BrowserService());
    keptRegistry = new KeptBrowserRegistry(pool);
    registry = new RunRegistry();
    registry.start({
      runId: agentIdentity.runId,
      sessionId: agentIdentity.conversationId,
      workspace: process.cwd(),
    });
    runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    adapter = new ManagedBrowserProviderAdapter(
      runtime,
      (serviceKey) => pool.acquire(serviceKey),
      (serviceKey) => pool.releaseAgent(serviceKey),
      {
        exportForConversation: async () => '/dev/null',
        importForConversation: async () => false,
        clearConversation: async () => undefined,
        activateConversation: () => undefined,
      },
      undefined,
      keptRegistry,
    );
  }, 30_000);

  afterAll(async () => {
    // 收尾：关掉所有残留服务，不留 chromium 进程。
    for (const key of pool.listAgents()) {
      await pool.releaseAgent(key).catch(() => undefined);
    }
    await pool.acquire().close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }, 30_000);

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server?.address() as AddressInfo;
    formUrl = `http://127.0.0.1:${address.port}/form`;
    otherUrl = `http://127.0.0.1:${address.port}/other`;
  }, 10_000);

  it(
    'agent submits the form, keeps the result page, run ends, result window stays alive, cleanup on close',
    async () => {
      // ── 1. agent run：搜索页（中间页）→ 表单页 → 填写提交 ──────────────────
      const execute = (operationId: string, action: string, provider: (service: BrowserService) => Promise<void>) =>
        adapter.execute({
          identity: agentIdentity,
          operationId,
          action,
          params: { action },
          async executeProvider(_signal, browserService) {
            await provider(browserService);
            return { success: true, output: `${action} done` };
          },
        });

      expect((await execute('open-search', 'navigate', async (service) => {
        await service.navigate(otherUrl);
      })).success).toBe(true);
      expect((await execute('open-form', 'new_tab', async (service) => {
        await service.newTab(formUrl);
      })).success).toBe(true);
      expect((await execute('fill', 'type', async (service) => {
        await service.type('#q', 'smoke-keep-value');
      })).success).toBe(true);
      expect((await execute('submit', 'click', async (service) => {
        await service.click('#submit');
      })).success).toBe(true);

      const tabsBeforeKeep = keptBrowserServiceTabs();
      expect(tabsBeforeKeep.length).toBe(2);

      // ── 2. keep_result_page：中间页关闭，结果页标记 kept ──────────────────
      const keepResult = await executeKeepResultPage({
        identity: agentIdentity,
        browserService: adapter.getBinding(agentIdentity)!.browserService,
        context: { sessionId: agentIdentity.conversationId },
        params: { action: 'keep_result_page' },
        adapter,
      });
      expect(keepResult.success).toBe(true);

      const keptService = adapter.getBinding(agentIdentity)!.browserService;
      const tabsAfterKeep = keptService.listTabs();
      expect(tabsAfterKeep.length).toBe(1);
      expect(tabsAfterKeep[0].url).toContain('/form');

      const keptEntry = keptRegistry.get(agentIdentity.conversationId);
      expect(keptEntry).toMatchObject({ url: expect.stringContaining('/form'), state: 'kept' });

      // ── 3. run 结束：结果窗不随清理关闭（keep 生效的直接证据）──────────────
      const profileDir = keptService.getSessionState().profileDir as string;
      expect(fs.existsSync(profileDir)).toBe(true);
      await runtime.endRun(agentIdentity);
      expect(keptService.isRunning()).toBe(true);
      expect(pool.hasAgent(keptEntry!.serviceKey)).toBe(true);
      expect(keptRegistry.get(agentIdentity.conversationId)?.state).toBe('kept');

      // ── 6. 闲置回收（lease 到期 → service.close）：closed + URL 留存 + 无泄漏 ─
      const savedUrl = keptRegistry.get(agentIdentity.conversationId)!.url;
      const keptServiceKey = keptEntry!.serviceKey;
      await keptService.close();

      expect(keptRegistry.get(agentIdentity.conversationId)?.state).toBe('closed');
      expect(keptRegistry.get(agentIdentity.conversationId)).toMatchObject({
        state: 'closed',
        url: savedUrl,
      });
      // 临时 profile 目录已删 + 池条目已释放（不泄漏）。
      expect(fs.existsSync(profileDir)).toBe(false);
      expect(pool.hasAgent(keptServiceKey)).toBe(false);
      expect(keptService.isRunning()).toBe(false);
    },
    TIMEOUT_MS,
  );

  function keptBrowserServiceTabs(): Array<{ id: string; url: string; title: string }> {
    const binding = adapter.getBinding(agentIdentity);
    if (!binding) throw new Error('agent binding missing before keep');
    return binding.browserService.listTabs();
  }
});
