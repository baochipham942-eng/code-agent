// ============================================================================
// E2E: swarm-chain — 验证 SwarmEvent 从后端穿越整条链路到达 DOM
// ============================================================================
//
// 真实路径（生产代码，零 mock）:
//   POST /api/dev/emit-swarm-event
//     → EventBus.publish('swarm', ...)
//     → swarm.ipc ensureSwarmBusBridge 订阅器
//     → deliverSwarmEvent
//     → AppWindow.getAllWindows() [webModeWindow]
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

async function ensureActiveSession(page: Page): Promise<string> {
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  if (!(await activeSession.isVisible())) {
    const newSessionBtn = page.getByRole('button', { name: '新会话' });
    await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
    await newSessionBtn.click();
  }
  await expect(activeSession).toBeVisible({ timeout: 10_000 });

  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing after creating a clean E2E session').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  return sessionId!;
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
  const sessionId = await ensureActiveSession(page);
  const base = Date.now();
  const runId = `e2e-run-${base}`;
  const treeId = `e2e-tree-${base}`;

  // 2. 注入 swarm:started —— 会触发 setShowTaskPanel(true) + setTaskPanelTab('orchestration')
  await emitSwarmEvent(request, token, {
    type: 'swarm:started',
    sessionId,
    runId,
    treeId,
    timestamp: base,
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
  const uniqueAgentName = `e2e-scout-${base}`;
  await emitSwarmEvent(request, token, {
    type: 'swarm:agent:added',
    sessionId,
    runId,
    treeId,
    timestamp: base + 1,
    data: {
      agentState: {
        id: `e2e-agent-${base}`,
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

  // 5. 收尾（2026-08-06）：本用例往会话账本里塞了一名 scout，必须自己收干净。
  //    背景：用例之间会共用同一个「新对话」——app 点新任务时复用没有消息的空会话。
  //    这名 scout 一旦留在账本里，后续用例的成员条/概览会把它当本会话成员读出来
  //    （实测 workbench-overview 的 Todo 模块因此长出 e2e-scout 一行）。
  //    ① agent 与 run 都落终态；② 给会话写一条消息让它不再是「空会话」，
  //    后续用例点新任务就会真正新建一个干净会话，而不是继承这份账本。
  await emitSwarmEvent(request, token, {
    type: 'swarm:agent:completed',
    sessionId,
    runId,
    treeId,
    timestamp: base + 2,
    data: {
      agentState: {
        id: `e2e-agent-${base}`,
        name: uniqueAgentName,
        role: 'scout',
        status: 'completed',
        iterations: 1,
        startTime: Date.now(),
      },
    },
  });
  await emitSwarmEvent(request, token, {
    type: 'swarm:completed',
    sessionId,
    runId,
    treeId,
    timestamp: base + 3,
    data: {
      statistics: {
        total: 1,
        completed: 1,
        failed: 0,
        running: 0,
        pending: 0,
        parallelPeak: 1,
        totalTokens: 0,
        totalToolCalls: 0,
      },
      result: { success: true, totalTime: 1 },
    },
  });

  const closeoutTurnId = `e2e-swarm-chain-closeout-${base}`;
  const closeoutResponse = await request.post('/api/dev/emit-agent-events', {
    data: {
      events: [
        { type: 'turn_start', sessionId, data: { turnId: closeoutTurnId } },
        { type: 'stream_chunk', sessionId, data: { turnId: closeoutTurnId, content: 'swarm chain e2e 收尾。' } },
        { type: 'turn_end', sessionId, data: { turnId: closeoutTurnId } },
      ],
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(closeoutResponse.ok(), 'swarm-chain 收尾消息写入失败').toBe(true);
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
  const sessionId = await ensureActiveSession(page);
  const base = Date.now();
  const runId = `e2e-launch-run-${base}`;
  const treeId = `e2e-launch-tree-${base}`;

  const launchRequestId = `e2e-launch-${base}`;
  await emitSwarmEvent(request, token, {
    type: 'swarm:launch:requested',
    sessionId,
    runId,
    treeId,
    timestamp: base,
    data: {
      launchRequest: {
        id: launchRequestId,
        sessionId,
        runId,
        treeId,
        status: 'pending',
        requestedAt: base,
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
  // 施工单二 B：轻量 inline 问答（批准 N 个成员 + 摘要 + 批准/拒绝）
  await expect(chatLog).toContainText('批准 2 个成员启动？');
  await expect(chatLog).toContainText('等待启动审批');
  await expect(chatLog).toContainText('批准');
  await expect(chatLog).toContainText('取消');
});
