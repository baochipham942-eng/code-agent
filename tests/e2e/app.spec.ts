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
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
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

  // 找到 textarea（通过 aria-label 或 data-chat-input 属性）
  const textarea = page.locator('[data-chat-input]');
  await expect(textarea).toBeVisible({ timeout: 15_000 });

  // 输入文字
  await textarea.fill('你好，这是一条测试消息');
  await expect(textarea).toHaveValue('你好，这是一条测试消息');
});

// ----------------------------------------------------------------------------
// 4. 新建会话
// ----------------------------------------------------------------------------
test('可以新建会话', async ({ page }) => {
  await page.goto('/');

  // 点击「新会话」按钮
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  // 新建后侧边栏应该出现会话条目（至少有一个会话元素）
  // 会话标题默认是「新对话」或「未命名会话」
  const sessionItem = page.getByText(/新对话|未命名会话/);
  await expect(sessionItem.first()).toBeVisible({ timeout: 10_000 });
});

test('可以从侧边栏切换会话', async ({ page }) => {
  await page.goto('/');

  const sessionItems = page.locator('[data-session-id]');
  await expect(sessionItems.first()).toBeVisible({ timeout: 15_000 });

  let sessionIds = await sessionItems.evaluateAll((items) =>
    Array.from(new Set(items.map((item) => item.getAttribute('data-session-id')).filter(Boolean))),
  );

  if (sessionIds.length < 2) {
    const newSessionBtn = page.getByRole('button', { name: '新会话' });
    await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
    await newSessionBtn.click();
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

// ----------------------------------------------------------------------------
// 6. TitleBar 按钮功能
// ----------------------------------------------------------------------------
test('TitleBar 按钮可点击', async ({ page }) => {
  await page.goto('/');

  // 等待 TitleBar 渲染
  const titleBar = page.locator('.h-12.flex.items-center');
  await expect(titleBar.first()).toBeVisible({ timeout: 15_000 });

  // 侧边栏折叠/展开按钮
  const sidebarToggle = page.getByLabel(/Show sidebar|Hide sidebar/);
  await expect(sidebarToggle).toBeVisible();

  // 点击折叠侧边栏
  await sidebarToggle.click();

  // 折叠后「新会话」按钮应该不可见
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).not.toBeVisible({ timeout: 3_000 });

  // 再次点击展开
  await sidebarToggle.click();
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
