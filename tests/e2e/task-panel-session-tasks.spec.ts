import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentEvent, SessionTask } from '../../src/shared/contract';

type RendererAgentEvent = AgentEvent & { sessionId?: string };

test.setTimeout(60_000);

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing').toBeTruthy();
  return token!;
}

async function createCleanSession(page: Page): Promise<string> {
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 10_000 });

  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  return sessionId!;
}

async function emitAgentEvents(
  request: APIRequestContext,
  token: string,
  events: RendererAgentEvent[],
): Promise<void> {
  const response = await request.post('/api/dev/emit-agent-events', {
    data: { events },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.ok(),
    `emit-agent-events failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

function task(overrides: Partial<SessionTask> & Pick<SessionTask, 'id' | 'subject' | 'status'>): SessionTask {
  return {
    description: overrides.subject,
    activeForm: overrides.subject,
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('task_update renders SessionTask lifecycle and dependencies in the task panel', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const sessionId = await createCleanSession(page);

  await emitAgentEvents(request, token, [{
    type: 'task_update',
    sessionId,
    data: {
      action: 'sync',
      source: 'e2e',
      tasks: [
        task({
          id: 'task-a',
          subject: '准备数据源',
          status: 'completed',
          blocks: ['task-b'],
        }),
        task({
          id: 'task-b',
          subject: '渲染依赖状态',
          status: 'pending',
          blocks: ['task-c'],
          blockedBy: ['task-a'],
        }),
        task({
          id: 'task-c',
          subject: '等待前置检查',
          status: 'pending',
          blockedBy: ['task-b'],
        }),
        task({
          id: 'task-d',
          subject: '放弃旧路径',
          status: 'cancelled',
        }),
      ],
    },
  }]);

  await expect(page.getByText('等待前置检查').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('等待 渲染依赖状态').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('1/3').first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /已完成 2 项/ }).click();
  await expect(page.getByText('放弃旧路径').first()).toBeVisible({ timeout: 10_000 });
});
