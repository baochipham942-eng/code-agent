// ============================================================================
// Core E2E Tests - 核心页面功能验证
// Web Server 模式下运行（无需 Tauri/Electron）
// ============================================================================

import { test, expect } from '@playwright/test';

// 每个测试的超时
test.setTimeout(30_000);

// ----------------------------------------------------------------------------
// 1. 页面加载
// ----------------------------------------------------------------------------
test('应用加载成功', async ({ page }) => {
  await page.goto('/');

  // 验证页面标题或根元素存在
  await expect(page.locator('body')).toBeVisible();

  // 应用主容器（bg-zinc-950）应该渲染出来
  const appContainer = page.locator('.h-screen');
  await expect(appContainer).toBeVisible();
});

// ----------------------------------------------------------------------------
// 2. 侧边栏可见
// ----------------------------------------------------------------------------
test('侧边栏显示', async ({ page }) => {
  await page.goto('/');

  // 侧边栏包含「新会话」按钮
  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });

  // 底部账号入口在未登录时显示「登录」，已登录时显示「用户菜单」。
  await expect(
    page.getByRole('button', { name: '登录' }).or(page.getByRole('button', { name: '用户菜单' })),
  ).toBeVisible();
});

// ----------------------------------------------------------------------------
// 3. 聊天输入框可交互
// ----------------------------------------------------------------------------
test('聊天输入框可输入', async ({ page }) => {
  await page.goto('/');

  // 输入区是 contentEditable 的 div（role=textbox），不是 <input>/<textarea>：
  // toHaveValue 在它身上永远报 "Not an input element"，断言要走文本内容。
  const composer = page.locator('[data-chat-input]');
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // 输入文字
  await composer.fill('你好，这是一条测试消息');
  await expect(composer).toHaveText('你好，这是一条测试消息');
});

// ----------------------------------------------------------------------------
// 4. 新建会话
// ----------------------------------------------------------------------------
test('可以新建会话', async ({ page }) => {
  await page.goto('/');

  // 点击「新会话」按钮
  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  // 新建后侧边栏应该出现会话条目（至少有一个会话元素）
  // 会话标题默认是「新对话」或「未命名会话」
  const sessionItem = page.getByText(/新对话|未命名会话/);
  await expect(sessionItem.first()).toBeVisible({ timeout: 10_000 });
});

test('可以从侧边栏切换会话', async ({ page, request }) => {
  await page.goto('/');

  const sessionItems = page.locator('[data-session-id]');
  await expect(sessionItems.first()).toBeVisible({ timeout: 15_000 });

  let sessionIds = await sessionItems.evaluateAll((items) =>
    Array.from(new Set(items.map((item) => item.getAttribute('data-session-id')).filter(Boolean))),
  );

  if (sessionIds.length < 2) {
    // 不能靠再点一次「新任务」：全新数据目录上第一条本来就是空的「新对话」，
    // 产品行为是复用它而不是再开一条（2026-08-18 实测连点两次仍然只有 1 行）。
    // 用 REST 建第二条（new-session.e2e.spec.ts 已验证过的同一条路），SSE 会把它推进侧栏。
    const token = await page.evaluate(() =>
      (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
    );
    expect(token, 'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke').toBeTruthy();
    const response = await request.post('/api/sessions', {
      data: { title: `切会话用第二条 ${Date.now()}` },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok(), `POST /api/sessions failed: ${response.status()}`).toBe(true);
    await expect(sessionItems.nth(1)).toBeVisible({ timeout: 10_000 });
    sessionIds = await sessionItems.evaluateAll((items) =>
      Array.from(new Set(items.map((item) => item.getAttribute('data-session-id')).filter(Boolean))),
    );
  }

  expect(sessionIds.length).toBeGreaterThanOrEqual(2);
  const currentSessionId = await page.locator('[data-session-id][aria-current="true"]').first().getAttribute('data-session-id');
  const targetSessionId = sessionIds.find((id) => id !== currentSessionId);
  expect(targetSessionId).toBeTruthy();

  await page.locator(`[data-session-id="${targetSessionId}"]`).click();
  await expect(page.locator(`[data-session-id="${targetSessionId}"]`)).toHaveAttribute('aria-current', 'true');
});

// ----------------------------------------------------------------------------
// 5. 设置面板可打开（通过 Sidebar 底部用户菜单或 TitleBar）
// ----------------------------------------------------------------------------
test('账号入口可打开登录或设置面板', async ({ page }) => {
  await page.goto('/');

  const loginBtn = page.getByRole('button', { name: '登录' });
  const userMenuBtn = page.getByRole('button', { name: '用户菜单' });
  await expect(loginBtn.or(userMenuBtn)).toBeVisible({ timeout: 15_000 });

  if (await userMenuBtn.isVisible().catch(() => false)) {
    await userMenuBtn.click();
    const settingsBtn = page.getByRole('button', { name: '设置', exact: true });
    await expect(settingsBtn).toBeVisible({ timeout: 5_000 });
    await settingsBtn.click();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible({ timeout: 5_000 });
    return;
  }

  if (await loginBtn.isVisible().catch(() => false)) {
    await loginBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('dialog')).toContainText('登录');
    return;
  }
});

// 原名「Workbench 可打开 Skills、上下文与 MCP 设置页」。ADR-049（07-23 拍、07-27 修订）
// 把 Skills/连接器的唯一入口收进侧栏「能力中心」：workbench 的 Skills/上下文面板已下线
// （SkillsPanel 在 renderer 里已无挂载点，「打开面板」按钮在 src 里也已不存在，
// WorkbenchTabs 现在只剩 概览/文件/浏览器/终端/画布）。断言随之改测现在的入口。
test('侧栏能力中心可打开 Skills 与连接器', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('sidebar-capability-hub').click();
  const hub = page.getByTestId('capability-hub-page');
  await expect(hub).toBeVisible({ timeout: 15_000 });

  await hub.getByTestId('capability-hub-tab-skills').click();
  // Skills 页结构为「已安装 (N) / 发现安装」子 tab；断言稳定的子 tab 标签而非 heading 文案。
  await expect(hub.getByText('发现安装')).toBeVisible({ timeout: 10_000 });
  await expect(hub.getByText(/已安装 \(\d+\)/)).toBeVisible();

  // 连接器页同样是两个子 tab，默认落「发现连接」；「服务器配置」在「已连接 (N)」下。
  await hub.getByTestId('capability-hub-tab-connectors').click();
  await expect(hub.getByText('发现连接')).toBeVisible({ timeout: 10_000 });
  await hub.getByText(/已连接 \(\d+\)/).click();
  await expect(hub.getByText('服务器配置')).toBeVisible({ timeout: 10_000 });
});

// ----------------------------------------------------------------------------
// 6. TitleBar 按钮功能
// ----------------------------------------------------------------------------
test('TitleBar 按钮可点击', async ({ page }) => {
  await page.goto('/');

  // 等待 TitleBar 渲染
  const titleBar = page.locator('.h-12.flex.items-center');
  await expect(titleBar.first()).toBeVisible({ timeout: 15_000 });

  // 收起开关坐在侧栏自己头上，展开入口在 TitleBar（侧栏收起时它不存在，按钮得另有落脚点）
  const collapseBtn = page.getByTestId('sidebar-collapse');
  await expect(collapseBtn).toBeVisible();

  // 点击折叠侧边栏
  await collapseBtn.click();

  // 折叠后「新会话」按钮应该不可见
  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).not.toBeVisible({ timeout: 3_000 });

  // 从 TitleBar 的展开入口再展开
  await page.getByTestId('titlebar-expand-sidebar').click();
  await expect(newSessionBtn).toBeVisible({ timeout: 3_000 });
});

// ----------------------------------------------------------------------------
// 7. 附件按钮存在
// ----------------------------------------------------------------------------
test('附件按钮可见', async ({ page }) => {
  await page.goto('/');

  const addMenuBtn = page.getByRole('button', { name: '更多输入选项' });
  await expect(addMenuBtn).toBeVisible({ timeout: 15_000 });
  await addMenuBtn.click();

  const uploadBtn = page.getByRole('button', { name: '上传图片或文件' });
  await expect(uploadBtn).toBeVisible({ timeout: 5_000 });
});

// ----------------------------------------------------------------------------
// 8. 页面无 JS 错误
// ----------------------------------------------------------------------------
test('页面无严重 JS 错误', async ({ page }) => {
  const errors: string[] = [];

  page.on('pageerror', (err) => {
    // 过滤掉已知的非致命错误（如 API 调用失败）
    if (!err.message.includes('Failed to fetch') &&
        !err.message.includes('NetworkError') &&
        !err.message.includes('AbortError')) {
      errors.push(err.message);
    }
  });

  await page.goto('/');

  // 等待页面完全加载
  await page.waitForTimeout(3_000);

  // 不应有严重的 JS 错误
  expect(errors).toEqual([]);
});
