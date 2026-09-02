// ============================================================================
// 给成员补话（N-SUBAGENT-INPUT）全链路：真会话 + 真后台 run（E2E 本地假模型，零付费）
// dev exec-tool 直接执行 delegate_task 起一个后台任务（子 run 停在 AskUserQuestion 上等审批 =
// 稳定的「运行中」态）→ 打开会话 → 右栏「专家」页签 → 点这位成员进成员视图 → 底部输入框 Enter 补一句
// → 回执「已读到」→ 会话账本里出现这句（isMeta + memberInput 元数据 = 已注入该 run 的模型上下文）。
// 跑法：CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1。不走团长 /api/run：09-02 真跑抓到该路由的前台 brain
// 工具面把 delegate_task/task_status 剔掉了（Run policy toolset 16→8，removed 含 delegate_task），
// 是另一个病，另开单；本 spec 只验本单的链路。也不走主输入框（e2e 数据目录没配模型 key）。
// ============================================================================
import { test, expect, type APIRequestContext, type Page } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

const BACKGROUND_APPROVAL_MARKER = 'E2E_BACKGROUND_APPROVAL';
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

/** delegate_task 的输出：`accepted：后台任务「短名」(<id>) 已开始。…`，后台任务 id 从括号里拿。 */
function parseDelegatedTaskId(output: unknown): string | null {
  if (typeof output !== 'string') return null;
  return output.match(/「[^」]*」\(([^()\s]+)\)/)?.[1] ?? null;
}

test('成员视图底部输入框给运行中的后台任务补一句：回执「已读到」，账本里出现这句并带 memberInput 元数据', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const token = await getAuthToken(page);

  // 1. 真会话 + 真后台 run：dev exec-tool 直接执行 delegate_task（子 run 停在 AskUserQuestion 上等审批）
  const created = await request.post('/api/sessions', {
    data: { title: '给成员补话 e2e' },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(created.ok(), `create session failed: ${created.status()}`).toBe(true);
  const sessionId = (await created.json()).data.id as string;

  const delegated = await request.post('/api/dev/exec-tool', {
    data: {
      tool: 'delegate_task',
      sessionId,
      allowWrite: true,
      params: {
        title: '后台审批验收',
        short_name: '审批任务',
        lane_key: 'acceptance-approval',
        submission_key: `e2e-member-input-${Date.now()}`,
        prompt: BACKGROUND_APPROVAL_MARKER,
      },
    },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
  });
  expect(delegated.ok(), `delegate_task failed: ${delegated.status()} ${(await delegated.text()).slice(0, 300)}`).toBe(true);
  const delegatedBody = await delegated.json() as { success?: boolean; output?: unknown; error?: unknown };
  expect(delegatedBody.success, `delegate_task error: ${String(delegatedBody.error)}`).toBe(true);
  const taskId = parseDelegatedTaskId(delegatedBody.output);
  expect(taskId, `task id missing in output: ${String(delegatedBody.output)}`).toBeTruthy();

  // 2. 打开会话 → 成员条 chip 进「专家」面板 → 点这位成员进成员视图
  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  // 右栏默认收起：从成员条的折叠 chip（「1 个代理工作中 · …」）进「专家」面板，和用户真实路径一致
  await page.getByTestId('session-member-bar-collapsed').click();
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

  // 5. 回主会话：折叠记录一行在（主输入框回来）
  await page.getByTestId('member-view-back').click();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('member-input-note').first()).toContainText(SUPPLEMENT, { timeout: 15_000 });

  // 6. 答掉子 run 的那个问题（拒绝 = 任务收尾）→ 浮卡消失，折叠记录露出来；任务终态唤醒团长的
  //    那条 meta 消息要带「期间用户直接给它补了 1 句」（N-TASKWAKE 摘要接上本单的计数）
  // 「回答 · 拒绝」= UserQuestionCard 的 skip（declined:true）；别用宽正则——选项「拒绝」也是 button，会先被匹上
  const card = page.getByTestId('user-question-card').first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByRole('button', { name: '回答 · 拒绝', exact: true }).click();
  await expect(page.getByText('允许后台任务继续完成验收吗')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('member-input-note').first()).toBeVisible({ timeout: 10_000 });
  if (shotDir) await page.screenshot({ path: `${shotDir}/member-input-main-record.png`, fullPage: false });

  await expect.poll(async () => {
    const messages = await listMessages(request, token, sessionId);
    return messages.some((message) => (
      message.role === 'user'
      && message.isMeta === true
      && typeof message.content === 'string'
      && message.content.startsWith('后台任务 ')
      && message.content.includes('期间用户直接给它补了 1 句')
    ));
  }, { timeout: 45_000, intervals: [1000, 2000] }).toBe(true);
});
