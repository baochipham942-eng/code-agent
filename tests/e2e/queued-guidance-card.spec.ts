// ============================================================================
// E2E: 引导（排队）消息卡的真实布局
// ============================================================================
//
// 单测只能钉住源码里的挂载位置，钉不住"它在屏幕上到底长在哪、有没有把输入区撑高"。
// 本 spec 在真 renderer 里量 boundingBox：卡片必须整体在输入框上方，且不是输入框
// 容器的后代——旧形态就是把气泡塞进输入框容器内部，textarea 与底部工具栏之间。
//
// 排队状态直接写宿主台账造，不调模型，因此本 spec 零 API 花费。
// ============================================================================

import { test, expect } from '@playwright/test';

test.setTimeout(60_000);

test('排队消息卡浮在输入框上方，且不在输入框容器内', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });

  // 侧栏启动时已有一个活跃会话；没有才去点「新任务」。
  // 注意：别用 name:'新会话' —— 那是几个既有 spec 里的过时文案，现在叫「新任务 / 新对话」。
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  if (await activeSession.count() === 0) {
    await page.getByRole('button', { name: '新任务' }).first().click();
  }
  await expect(activeSession).toBeVisible({ timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();

  // 首次进入工作目录会弹「信任这个项目文件夹?」，它盖住输入区。选「阻止项目配置」——
  // 本 spec 只看布局，不需要加载项目级配置。
  const trustTitle = page.getByText('信任这个项目文件夹', { exact: false }).first();
  if (await trustTitle.count() > 0) {
    // 「阻止项目配置」两处同名按钮点了都不关窗（onBlock 在 E2E 环境里没落地），
    // 走「信任并加载」——E2E 的 HOME/数据目录都是临时目录，加载的是本仓自己的配置。
    await page.getByRole('button', { name: '信任并加载' }).first().click();
    await expect(trustTitle).toBeHidden({ timeout: 10_000 });
  }

  const chatInput = page.locator('[data-chat-input]');
  await expect(chatInput).toBeVisible({ timeout: 10_000 });
  const inputHeightBefore = (await chatInput.boundingBox())?.height ?? 0;
  expect(inputHeightBefore).toBeGreaterThan(0);

  // 造「已排队」状态：直接往宿主台账写一条 queued 记录，再让页面重新 hydrate。
  // 不走「发消息 → 排队」是因为 renderer 只在自己发消息时才置会话为运行中
  // （useAgentIPC:938），注入事件造不出那个态；而且真发消息要花模型钱。
  const queuedId = `e2e-queued-${Date.now()}`;
  const enqueued = await page.evaluate(async ({ id, session }) => {
    const api = (window as unknown as {
      codeAgentDomainAPI?: { invoke: (d: string, a: string, p: unknown) => Promise<{ success: boolean; error?: { message: string } }> };
      domainAPI?: { invoke: (d: string, a: string, p: unknown) => Promise<{ success: boolean; error?: { message: string } }> };
    }).codeAgentDomainAPI ?? (window as unknown as {
      domainAPI?: { invoke: (d: string, a: string, p: unknown) => Promise<{ success: boolean; error?: { message: string } }> };
    }).domainAPI;
    if (!api) return { success: false, error: { message: 'domainAPI missing' } };
    return api.invoke('domain:queuedInput', 'enqueue', {
      id,
      sessionId: session,
      envelope: {
        content: '这是一条引导消息',
        sessionId: session,
        clientMessageId: id,
        context: { runtimeInput: { mode: 'supplement', delivery: 'queued_next_turn' } },
      },
    });
  }, { id: queuedId, session: sessionId! });
  expect(enqueued.success, `enqueue 失败：${enqueued.error?.message ?? ''}`).toBe(true);

  await page.reload();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 15_000 });

  const card = page.locator('[data-testid="queued-runtime-input-card"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // 1. 不是输入框容器的后代（旧形态就是塞在里面）
  const nestedInsideInputContainer = await card.evaluate((node) => {
    const input = document.querySelector('[data-chat-input]');
    if (!input) return 'no-input';
    // 输入框容器 = textarea 往上第一个圆角容器
    const container = input.closest('div.rounded-2xl');
    if (!container) return 'no-container';
    return container.contains(node) ? 'nested' : 'sibling';
  });
  expect(nestedInsideInputContainer, '排队卡又回到输入框容器里了——它会重新撑高输入区').toBe('sibling');

  // 2. 整体在输入框上方
  const cardBox = await card.boundingBox();
  const inputBox = await chatInput.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(
    cardBox!.y + cardBox!.height,
    '排队卡的底边越过了输入框顶边，说明它没有浮在输入框上方',
  ).toBeLessThanOrEqual(inputBox!.y + 1);

  // 3. 没把输入区撑高
  expect(
    inputBox!.height,
    '输入框被排队卡撑高了——卡片应当是自己的容器',
  ).toBeLessThanOrEqual(inputHeightBefore + 1);

  // 4. 折叠态只露计数，不铺正文
  await expect(page.locator('[data-testid="queued-runtime-input-count"]')).toBeVisible();
});
