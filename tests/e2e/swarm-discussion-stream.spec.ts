// ============================================================================
// E2E: swarm 讨论流（P1-3 多 agent 协作过程可见性）
// ============================================================================
// 验证 swarm:context:update 事件穿越真实链路（EventBus → SSE → swarmStore →
// SwarmInlineMonitor）后，「讨论流」渲染出发现 / 决策 / 人话状态，且决策点高亮。
//
// 真实路径同 swarm-chain.spec.ts：仅 POST /api/dev/emit-swarm-event 是 test-only，
// 其余节点全是生产代码。
// ============================================================================

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { SwarmEvent } from '../../src/shared/contract/swarm';

test.setTimeout(60_000);

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke').toBeTruthy();
  return token!;
}

async function emitSwarmEvent(
  request: APIRequestContext,
  token: string,
  event: SwarmEvent,
): Promise<void> {
  const response = await request.post('/api/dev/emit-swarm-event', {
    data: event,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.ok(),
    `emit-swarm-event failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

test('swarm:context:update 渲染成讨论流，决策点高亮', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const base = Date.now();

  // 1. swarm 启动 + 一个运行中 agent —— SwarmInlineMonitor 浮层才会渲染
  await emitSwarmEvent(request, token, {
    type: 'swarm:started',
    timestamp: base,
    data: {
      statistics: { total: 1, completed: 0, failed: 0, running: 1, pending: 0, parallelPeak: 1, totalTokens: 0, totalToolCalls: 0 },
    },
  });
  await emitSwarmEvent(request, token, {
    type: 'swarm:agent:added',
    timestamp: base + 1,
    data: {
      agentState: { id: 'agent_researcher_0', name: '研究员', role: 'researcher', status: 'running', iterations: 0, startTime: base + 1 },
    },
  });

  // 浮层出现
  await expect(page.getByText('background agent', { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  // 2. SharedContext 协作过程：发现 / 决策 / 人话状态
  const findingMark = `e2e-finding-${base}`;
  const decisionMark = `e2e-decision-${base}`;
  const statusMark = `e2e-status-${base}`;

  await emitSwarmEvent(request, token, {
    type: 'swarm:context:update',
    timestamp: base + 100,
    data: {
      agentId: 'agent_researcher_0',
      contextUpdate: { kind: 'finding', agentId: 'agent_researcher_0', role: '研究员', content: findingMark, at: base + 100 },
    },
  });
  await emitSwarmEvent(request, token, {
    type: 'swarm:context:update',
    timestamp: base + 200,
    data: {
      agentId: 'agent_researcher_0',
      contextUpdate: { kind: 'decision', agentId: 'agent_researcher_0', role: '研究员', content: decisionMark, at: base + 200 },
    },
  });
  await emitSwarmEvent(request, token, {
    type: 'swarm:context:update',
    timestamp: base + 300,
    data: {
      agentId: 'agent_researcher_0',
      contextUpdate: { kind: 'status', agentId: 'agent_researcher_0', role: '研究员', content: statusMark, at: base + 300 },
    },
  });

  // 3. 讨论流容器出现
  const stream = page.locator('[data-testid="discussion-stream"]');
  await expect(stream).toBeVisible({ timeout: 10_000 });

  // 展开看全量（折叠态默认只显最近 3 条，这里点开确保都能断言到）
  await stream.locator('[data-testid="discussion-stream-toggle"]').click();

  // 4. 三类条目都渲染，且角色名落到标题
  await expect(stream.getByText(findingMark)).toBeVisible({ timeout: 10_000 });
  await expect(stream.getByText(decisionMark)).toBeVisible();
  await expect(stream.getByText(statusMark)).toBeVisible();
  await expect(stream.getByText('研究员 发现', { exact: false }).first()).toBeVisible();

  // 5. 决策点条目高亮（data-highlight=true + 决策点徽标）
  const decisionEntry = stream.locator('[data-testid="discussion-entry"][data-context-kind="decision"]');
  await expect(decisionEntry).toHaveAttribute('data-highlight', 'true');
  await expect(decisionEntry.getByText('决策点')).toBeVisible();

  await page.screenshot({ path: 'screenshots/swarm-discussion-stream.png', fullPage: false });
});
