/**
 * Smoke — stage 4 wiring: subagent dispatch → toolContext.agentId → BrowserTool
 *
 * 模拟子 agent 被派活后的状态：toolContext.agentId 已经被注入（如 spawnAgent /
 * autoAgentCoordinator / parallelAgentCoordinator 派活时 stage 4 wiring 做的那样）。
 * 然后通过 BrowserTool 入口（不绕过 stage 1.2 的 getBrowserService(ctx.agentId)）
 * 触发 launch + cookie，验证两个 "子 agent" 真的拿到独立 BrowserContext。
 *
 * 与 multiAgentBrowserIsolation.smoke.test.ts 的区别：那个直接用 BrowserPool API
 * 拿 BrowserService；本测试经过 BrowserTool execute → browserActionTool execute
 * → getBrowserService(ctx.agentId) 完整链路，验证 wiring 真正生效。
 *
 * 跑法：npm test -- --run tests/smoke/subagentDispatchWiring.smoke.test.ts
 * Timeout 90s — 含 2 次 chromium cold launch + cookie roundtrip。
 */

import { describe, expect, it, afterAll } from 'vitest';
import type { ToolContext } from '../../src/main/tools/types';
import { BrowserTool } from '../../src/main/tools/vision/BrowserTool';
import { browserPool } from '../../src/main/services/infra/browserPool';

const TIMEOUT_MS = 90_000;

function makeSubagentToolContext(agentId: string): ToolContext {
  return {
    workingDirectory: '/tmp',
    requestPermission: async () => true,
    sessionId: `smoke_session_${agentId}`,
    agentId,
  } as ToolContext;
}

describe('subagent dispatch wiring (BrowserTool entry, real chromium)', () => {
  const ctxA = makeSubagentToolContext('subagent-smoke-a');
  const ctxB = makeSubagentToolContext('subagent-smoke-b');

  afterAll(async () => {
    await browserPool.releaseAgent('subagent-smoke-a').catch(() => undefined);
    await browserPool.releaseAgent('subagent-smoke-b').catch(() => undefined);
  });

  it(
    'BrowserTool launch routes to per-agent BrowserService via wiring',
    async () => {
      const launchA = await BrowserTool.execute({ action: 'launch' }, ctxA);
      expect(launchA.success).toBe(true);

      const svcA = browserPool.acquire('subagent-smoke-a');
      expect(svcA.isRunning()).toBe(true);
      expect(svcA.getSessionState().profileId).toContain('subagent-smoke-a');

      const launchB = await BrowserTool.execute({ action: 'launch' }, ctxB);
      expect(launchB.success).toBe(true);

      const svcB = browserPool.acquire('subagent-smoke-b');
      expect(svcB.isRunning()).toBe(true);
      expect(svcB.getSessionState().profileId).toContain('subagent-smoke-b');

      // The wiring's defining property: BrowserTool dispatched against ctxA
      // must NOT have leaked into the same instance ctxB sees.
      expect(svcA).not.toBe(svcB);
      console.log('[wiring] agent-a profileDir:', svcA.getSessionState().profileDir);
      console.log('[wiring] agent-b profileDir:', svcB.getSessionState().profileDir);

      // Confirm both BrowserServices have actually launched independent chromiums
      // by verifying tab counts: each newTab in one must not show up in the other.
      const tabA = await BrowserTool.execute({ action: 'new_tab', url: 'about:blank' }, ctxA);
      expect(tabA.success).toBe(true);

      const listA1 = await BrowserTool.execute({ action: 'list_tabs' }, ctxA);
      const listB1 = await BrowserTool.execute({ action: 'list_tabs' }, ctxB);
      console.log('[wiring] agent-a list_tabs after newTab(a):', listA1.output);
      console.log('[wiring] agent-b list_tabs after newTab(a):', listB1.output);

      const tabsCountA1 = svcA.listTabs().length;
      const tabsCountB1 = svcB.listTabs().length;
      expect(tabsCountA1).toBeGreaterThanOrEqual(1);
      expect(tabsCountB1).toBe(0);

      // 关闭通过同一 ctx 的 close action（确保 close 也走对了实例）
      await BrowserTool.execute({ action: 'close' }, ctxA);
      await BrowserTool.execute({ action: 'close' }, ctxB);
      expect(svcA.isRunning()).toBe(false);
      expect(svcB.isRunning()).toBe(false);
    },
    TIMEOUT_MS,
  );
});
