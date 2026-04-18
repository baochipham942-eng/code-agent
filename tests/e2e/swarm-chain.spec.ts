// ============================================================================
// E2E: swarm-chain — 验证 SwarmEvent 从后端穿越整条链路到达 DOM
// ============================================================================
//
// 真实路径（生产代码，零 mock）:
//   POST /api/dev/emit-swarm-event
//     → EventBus.publish('swarm', ...)
//     → swarm.ipc ensureSwarmBusBridge 订阅器
//     → deliverSwarmEvent
//     → BrowserWindow.getAllWindows() [webModeWindow]
//     → webContents.send('swarm:event', ...) [shim]
//     → broadcastToRenderer
//     → onRendererPush → broadcastSSE
//     → /api/events SSE stream
//     → EventSource in browser
//     → httpTransport listener
//     → ipcService.on(SWARM_EVENT)
//     → swarmStore.handleEvent
//     → Orchestration React 组件
//     → DOM
//
// 这一条链路里只有 `POST /api/dev/emit-swarm-event` 是 test-only，
// 其它所有节点都是生产代码。
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

test('swarm event 从 EventBus 一路传到 DOM', async ({ page, request }) => {
  // 在 goto 之前挂 waitForResponse, 避免错过立即发出的 SSE 初始请求
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  // 1. 打开 app，等待 renderer 完成挂载 + SSE 订阅建立
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);

  // 2. 注入 swarm:started —— 会触发 setShowTaskPanel(true) + setTaskPanelTab('orchestration')
  await emitSwarmEvent(request, token, {
    type: 'swarm:started',
    timestamp: Date.now(),
    data: {
      statistics: {
        total: 1,
        completed: 0,
        failed: 0,
        running: 0,
        pending: 1,
        parallelPeak: 0,
        totalTokens: 0,
        totalToolCalls: 0,
      },
    },
  });

  // 3. 注入一个独特名字的 agent，用它在 DOM 里当 probe
  const uniqueAgentName = `e2e-scout-${Date.now()}`;
  await emitSwarmEvent(request, token, {
    type: 'swarm:agent:added',
    timestamp: Date.now(),
    data: {
      agentState: {
        id: 'e2e-agent-1',
        name: uniqueAgentName,
        role: 'scout',
        status: 'running',
        iterations: 0,
        startTime: Date.now(),
      },
    },
  });

  // 4. 断言独特名字出现在 DOM 里 —— 整条链路贯通
  await expect(page.locator(`text=${uniqueAgentName}`).first()).toBeVisible({
    timeout: 10_000,
  });
});

test('dev route 拒绝格式非法的 body', async ({ page, request }) => {
  await page.goto('/');
  const token = await getAuthToken(page);

  const response = await request.post('/api/dev/emit-swarm-event', {
    data: { notAnEvent: true },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(400);
});

test('pending launch request 会以内联卡片出现在聊天区', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);

  const launchRequestId = `e2e-launch-${Date.now()}`;
  await emitSwarmEvent(request, token, {
    type: 'swarm:launch:requested',
    timestamp: Date.now(),
    data: {
      launchRequest: {
        id: launchRequestId,
        status: 'pending',
        requestedAt: Date.now(),
        summary: '等待启动审批',
        agentCount: 2,
        dependencyCount: 1,
        writeAgentCount: 1,
        tasks: [
          {
            id: 'task-a',
            role: 'scout',
            task: '先扫描仓库结构',
            dependsOn: [],
            tools: ['Read', 'Glob'],
            writeAccess: false,
          },
          {
            id: 'task-b',
            role: 'editor',
            task: '根据扫描结果修改文件',
            dependsOn: ['task-a'],
            tools: ['Read', 'Edit'],
            writeAccess: true,
          },
        ],
      },
    },
  });

  const chatLog = page.getByRole('log', { name: '对话消息' });
  await expect(chatLog).toBeVisible({ timeout: 10_000 });
  await expect(chatLog).toContainText('并行编排启动确认');
  await expect(chatLog).toContainText('等待启动审批');
  await expect(chatLog).toContainText('开始执行');
  await expect(chatLog).toContainText('取消编排');
});
