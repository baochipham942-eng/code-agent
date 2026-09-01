import {
  test,
  expect,
  scanA11y,
  type APIRequestContext,
  type Page,
} from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';
import { dismissFirstRunDialogs } from './firstRunDialogs';

type RendererAgentEvent = AgentEvent & { sessionId?: string };
type VisualTheme = 'light' | 'dark';

const RUNTIME_COMPOSER_PLACEHOLDER = '继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）';

test.setTimeout(90_000);
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  process.platform !== 'linux' && process.env.E2E_VISUAL_LOCAL_PROBE !== '1',
  '视觉基线只在 Swarm full 的 Ubuntu/Chromium 生成与比较',
);

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing').toBeTruthy();
  return token!;
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

async function createCleanSession(page: Page): Promise<string> {
  const newTask = page.getByTestId('sidebar-new-task');
  await expect(newTask).toBeVisible({ timeout: 15_000 });
  await newTask.click();

  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing after creating visual fixture session').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  return sessionId!;
}

async function openAppWithTheme(page: Page, theme: VisualTheme): Promise<void> {
  await page.addInitScript((selectedTheme: VisualTheme) => {
    localStorage.setItem('code-agent-theme', selectedTheme);
  }, theme);

  const ssePromise = page.waitForResponse(
    (response) => response.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  await dismissFirstRunDialogs(page);
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
  // 后端 settings 是权威源，E2E 空数据目录会在挂载后回写默认 light。等它落完后，
  // 再用产品同一套 localStorage + data-theme/class 机制固定本例主题。
  await page.evaluate((selectedTheme: VisualTheme) => {
    localStorage.setItem('code-agent-theme', selectedTheme);
    const root = document.documentElement;
    root.setAttribute('data-theme', selectedTheme);
    root.classList.remove('light', 'dark', 'high-contrast-light', 'high-contrast-dark');
    root.classList.add(selectedTheme);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function waitForStableVisualFrame(page: Page, theme: VisualTheme): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect.poll(
    () => page.evaluate(() => document.body.classList.contains('theme-switching')),
    { timeout: 10_000 },
  ).toBe(false);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect.poll(
    () => page.evaluate(() => localStorage.getItem('code-agent-theme')),
    { timeout: 10_000 },
  ).toBe(theme);
}

async function holdVisualTurnRunning(
  page: Page,
  request: APIRequestContext,
  token: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await expect(async () => {
    // 新会话的 idle session snapshot 可能在 E2E 注入 turn_start 之后才抵达，
    // 把运行态撤回 idle。截图前从真实 agent:event 链路补一个同 turn
    // keepalive，并以运行态 placeholder 上屏作为屏障。正文区已被 mask。
    await emitAgentEvents(request, token, [{
      type: 'stream_chunk',
      sessionId,
      data: { turnId, content: '等待危险命令审批。' },
    }]);
    await expect(page.getByText(RUNTIME_COMPOSER_PLACEHOLDER, { exact: true }))
      .toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function ensureWorkbenchExpandedForVisualFrame(page: Page): Promise<void> {
  const collapsePanel = page.getByRole('button', { name: '收起面板' }).first();
  const expandPanel = page.getByRole('button', { name: '展开面板' });

  if (await expandPanel.isVisible().catch(() => false)) {
    await expandPanel.click();
  }
  await expect(collapsePanel).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByText(RUNTIME_COMPOSER_PLACEHOLDER, { exact: true }))
    .toBeVisible({ timeout: 5_000 });
}

for (const theme of ['light', 'dark'] as const) {
  test(`危险命令审批卡 · ${theme}`, async ({ page, request }, testInfo) => {
    await openAppWithTheme(page, theme);
    const token = await getAuthToken(page);
    const sessionId = await createCleanSession(page);
    const turnId = `visual-approval-${theme}-${Date.now()}`;
    const requestId = `visual-dangerous-command-${theme}-${Date.now()}`;

    await emitAgentEvents(request, token, [
      { type: 'turn_start', sessionId, data: { turnId } },
      {
        type: 'stream_chunk',
        sessionId,
        data: { turnId, content: '正在准备高风险命令审批。' },
      },
      {
        type: 'permission_request',
        sessionId,
        data: {
          id: requestId,
          sessionId,
          forceConfirm: true,
          type: 'dangerous_command',
          tool: 'Bash',
          details: {
            command: 'rm -rf ./dist',
            commandRiskLevel: 'critical',
            commandSecurityFlags: ['recursive-delete'],
            affectedPath: './dist',
            affectedFileCount: 312,
            preview: {
              type: 'command',
              summary: '删除构建目录中的 312 个文件，且不进入回收站。',
            },
          },
          reason: '该命令会递归删除构建产物。',
          timestamp: Date.now(),
          dangerLevel: 'danger',
        },
      },
    ]);

    const permissionCard = page.getByTestId('permission-card');
    const streamingRegion = page.locator('[data-trace-turn-id] .space-y-2.px-4').first();
    const timestampRegion = page.locator('[data-trace-turn-id] span').filter({
      hasText: /^\d{2}:\d{2}$/,
    }).first();
    const avatarRegions = page.locator('img[alt=""], [data-testid^="role-initial-avatar-"]');
    const dynamicExpertIdentityRows = page.locator('[data-testid^="agents-panel-row-"]');
    const sessionMemberBar = page.getByTestId('session-member-bar-collapsed');

    await expect(permissionCard).toBeVisible({ timeout: 15_000 });
    await expect(permissionCard).toContainText('rm -rf ./dist');
    await expect(streamingRegion).toBeVisible({ timeout: 10_000 });
    await expect(timestampRegion).toHaveText(/^\d{2}:\d{2}$/);
    await waitForStableVisualFrame(page, theme);

    await holdVisualTurnRunning(page, request, token, sessionId, turnId);
    // Linux 基线记录的是右侧专家面板展开态。agent event 到达后显式恢复
    // 这一布局，等两帧并再次确认 turn 仍在运行。
    await ensureWorkbenchExpandedForVisualFrame(page);

    await expect(page.locator('.h-screen')).toHaveScreenshot(
      `dangerous-command-approval-${theme}.png`,
      {
        animations: 'disabled',
        caret: 'hide',
        mask: [
          timestampRegion,
          avatarRegions,
          dynamicExpertIdentityRows,
          sessionMemberBar,
          streamingRegion,
        ],
      },
    );

    // 新视觉 spec 仍走 axe fixture；只扫本用例新增的决策面，避免把同一页壳层的存量
    // 违规按新增测试次数重复累计进全局 node 计数。该根必须保持 0 违规。
    const axeRecord = await scanA11y(page, testInfo, {
      root: '[data-testid="permission-card"]',
      scanName: `visual-dangerous-command-${theme}`,
    });
    expect(axeRecord.violations).toEqual([]);
  });
}
