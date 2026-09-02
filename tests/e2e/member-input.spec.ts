// ============================================================================
// 给成员补话（N-SUBAGENT-INPUT）全链路：真会话 + 真 AgentLoop（HTTP /api/run，E2E 本地假模型，零付费）
// 团长 delegate_task 起一个后台任务（子 run 停在 AskUserQuestion 上等审批 = 稳定的「运行中」态）
// → 打开会话 → 右栏「专家」页签 → 点这位成员进成员视图 → 底部输入框 Enter 补一句
// → 回执「已读到」→ 会话账本里出现这句（isMeta + memberInput 元数据 = 已注入该 run 的模型上下文）。
// 跑法：CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（与 turn-rail.spec 同一套：走 HTTP 不走主输入框，
// e2e 数据目录没配模型 key，主输入框首发会被引到设置页；成员输入框直接调域 IPC 不受影响）。
// ============================================================================
import { test, expect, type APIRequestContext, type Page } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

const COMMAND_CENTER_MARKER = 'E2E_SESSION_COMMAND_CENTER';
const SUPPLEMENT = '顺便把页码加上 E2E_MEMBER_INPUT_SUPPLEMENT';

test.setTimeout(240_000);
test.skip(process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL !== '1', '需要 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1（本地假模型跑真后台任务，不进默认 e2e 批）');

async function dismissOverlays(page: Page): Promise<void> {
  await dismissFirstRunDialogs(page);
  for (const name of ['关闭', '信任并加载']) {
    const btn = page.getByRole('dialog').getByRole('button', { name }).first();
    await btn.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(btn).toBeHidden({ timeout: 10_000 });
    }
  }
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing').toBeTruthy();
  return token!;
}

type LedgerMessage = { id?: string; role?: string; content?: unknown; isMeta?: boolean; metadata?: Record<string, unknown> };

async function listMessages(request: APIRequestContext, token: string, sessionId: string): Promise<LedgerMessage[]> {
  const response = await request.get(`/api/sessions/${sessionId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) return [];
  const body = await response.json();
  return (body.data?.messages ?? body.data ?? body.messages ?? []) as LedgerMessage[];
}

/** 团长 delegate_task 的工具结果里带 `Task #<id> created:`，后台任务 id 就从这拿。 */
async function findCreatedTaskId(request: APIRequestContext, token: string, sessionId: string): Promise<string | null> {
  const messages = await listMessages(request, token, sessionId);
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    const match = text.match(/Task #([^\s"\\]+) created:/);
    if (match) return match[1];
  }
  return null;
}

test('成员视图底部输入框给运行中的后台任务补一句：回执「已读到」，账本里出现这句并带 memberInput 元数据', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const token = await getAuthToken(page);

  // 1. 真会话 + 真 AgentLoop：团长走命令中心派一个后台任务（SECOND = 停在 AskUserQuestion 上等审批的那支）
  const created = await request.post('/api/sessions', {
    data: { title: '给成员补话 e2e' },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(created.ok(), `create session failed: ${created.status()}`).toBe(true);
  const sessionId = (await created.json()).data.id as string;

  const run = await request.post('/api/run', {
    data: { sessionId, prompt: `${COMMAND_CENTER_MARKER} SECOND` },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
  });
  expect(run.ok(), `run failed: ${run.status()} ${(await run.text()).slice(0, 300)}`).toBe(true);
  let taskId: string | null = null;
  await expect.poll(async () => {
    taskId = await findCreatedTaskId(request, token, sessionId);
    return taskId;
  }, { timeout: 60_000, intervals: [500, 1000] }).toBeTruthy();

  // 2. 打开会话 → 右栏「专家」页签 → 点这位成员进成员视图
  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('workbench-tab-experts').click();
  const openMember = page.getByTestId(`agents-panel-open-${taskId}`);
  await expect(openMember).toBeVisible({ timeout: 30_000 });
  await openMember.click();

  const memberView = page.getByTestId('member-conversation-view');
  await expect(memberView).toBeVisible({ timeout: 10_000 });
  // 主输入框整块让位（不再是覆盖层）
  await expect(page.locator('[data-chat-input]')).toBeHidden();
  const shotDir = process.env.MEMBER_INPUT_SHOT_DIR;
  if (shotDir) await page.screenshot({ path: `${shotDir}/member-input-before-send.png`, fullPage: false });

  // 3. Enter 补一句 → 回执「已读到」（后台任务 steer = 已注入该 run 的模型上下文）
  const input = page.getByTestId('member-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(SUPPLEMENT);
  await input.press('Enter');
  const receipt = page.getByTestId('member-input-receipt');
  await expect(receipt).toHaveAttribute('data-state', 'read', { timeout: 20_000 });
  await expect(input).toHaveValue('');
  if (shotDir) await page.screenshot({ path: `${shotDir}/member-input-after-receipt.png`, fullPage: false });

  // 4. 账本：这句以 isMeta 落在主会话里，带 memberInput 元数据（团长收工汇总认得出）
  await expect.poll(async () => {
    const messages = await listMessages(request, token, sessionId);
    const record = messages.find((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes(SUPPLEMENT)
    ));
    if (!record) return null;
    const memberInput = record.metadata?.memberInput as { memberId?: string; mode?: string } | undefined;
    return { isMeta: record.isMeta === true, memberId: memberInput?.memberId, mode: memberInput?.mode };
  }, { timeout: 20_000, intervals: [500, 1000] }).toEqual({ isMeta: true, memberId: taskId, mode: 'supplement' });

  // 5. 回主会话：折叠记录一行可见（主输入框回来）
  await page.getByTestId('member-view-back').click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('member-input-note').first()).toContainText(SUPPLEMENT, { timeout: 15_000 });
  if (shotDir) await page.screenshot({ path: `${shotDir}/member-input-main-record.png`, fullPage: false });
});
