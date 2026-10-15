// ============================================================================
// 定时任务编辑器「单次预算上限 / 运行次数上限」字段 —— 真 app 几何验收
// （N-CRON-BUDGET-EXPOSE-SHOTS ①）
//
// 钉的东西（jsdom 单测看不见像素）：
//   1. 高级选项两个 FormField 的几何：label 与自己的 input 左缘对齐、两列 input
//      等宽等高、两列顶边同轴、hint 在自己的 field 盒内、整组不溢出 modal。
//   2. 各状态各存一张 PNG（test-results/）：清空 / 填了合法值 / 非法值（0、1.5、
//      -1 次数；-1 预算）报错可见 / 已有任务 maxRuns 3 + runCount 2 显示
//      「已运行 2/3 次」/ 新建任务空态。
//   3. 非法值必须就地给出**可见的中文**校验错（buildCronJobInput 客户端挡下，
//      不再把 host 的英文原文怼到用户脸上 —— 本单 ⑤ 的缺陷修复面）。
//
// 夹具：真 webServer（playwright.e2e.config 自管）+ 真 store + 真 DOM。已有任务
// 经产品自己的 domain 通道（/api/domain/cron/*，与 cronStore 同一条路）种入并
// 手动触发两趟把 runCount 推到 2；编辑器全程用 UI 打开，不绕过呈现层。
// ============================================================================

import { expect, test, type Page, type Locator } from './fixtures/axeTest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGeometrySensor, type GeometrySensor } from './fixtures/geometrySensor';

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOT_DIR = path.join(process.cwd(), 'test-results');
const MAX_RUNS_VALIDATION_MESSAGE = '运行次数上限必须是大于等于 1 的整数';
const BUDGET_VALIDATION_MESSAGE = '单次预算上限必须是大于等于 0 的数字';

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse((resp) => resp.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  // 首启浮层会吃掉侧栏点击：①文件夹信任 ②连接模型 onboarding ③被 onboarding「跳过」送进的设置页
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const btn = page.getByRole('button', { name });
    await btn.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click();
      await expect(btn.first()).toBeHidden({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

/** 与 cronStore 同一条 domain 通道调用 cron 域（webServer 启动时把 token 写进仓根 .dev-token）。 */
async function cronDomain(page: Page, action: string, payload: unknown): Promise<unknown> {
  const { origin } = new URL(page.url());
  const token = fs.readFileSync(path.join(REPO_ROOT, '.dev-token'), 'utf8').trim();
  const response = await fetch(`${origin}/api/domain/cron/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload }),
  });
  const body = await response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (!response.ok || body?.success === false) {
    throw new Error(`cron/${action}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body?.data;
}

interface SeededExecution { id: string; status: string }

/** 种入本地 shell 任务并把 runCount 推到 2（maxRuns 3 → 未触顶，任务保持启用）。 */
async function seedJobWithTwoRuns(page: Page, jobName: string): Promise<string> {
  const job = await cronDomain(page, 'createJob', {
    name: jobName,
    description: 'N-CRON-BUDGET-EXPOSE-SHOTS 截图夹具',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 5, unit: 'minutes' },
    runsOn: 'local',
    enabled: true,
    maxRetries: 0,
    maxRunBudget: 0.5,
    maxRuns: 3,
    action: { type: 'shell', command: 'echo neo-budget-shot' },
  }) as { id: string };
  for (let index = 0; index < 2; index++) {
    await cronDomain(page, 'triggerJob', { jobId: job.id });
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const executions = await cronDomain(page, 'getExecutions', { jobId: job.id, limit: 10 }) as SeededExecution[];
    if (executions.filter((row) => row.status === 'completed').length >= 2) return job.id;
    if (Date.now() > deadline) throw new Error(`seeded job runs did not settle: ${JSON.stringify(executions)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${name}`);
  return box;
}

/** FormField 的 label 文本 → 其包裹 div（label 的父节点就是 FormField 根）。 */
function budgetField(page: Page): Locator {
  return page.getByRole('dialog').getByText('单次预算上限 (USD)', { exact: true }).locator('xpath=..');
}

function runsField(page: Page): Locator {
  return page.getByRole('dialog').getByText('运行次数上限', { exact: true }).locator('xpath=..');
}

/** ① 的数值几何断言组：对「高级选项」两个额度字段整体钉一遍。 */
async function assertBudgetFieldsGeometry(page: Page): Promise<void> {
  const budget = budgetField(page);
  const runs = runsField(page);
  const budgetInput = await boxOf(budget.locator('input'), 'budget input');
  const runsInput = await boxOf(runs.locator('input'), 'maxRuns input');
  const budgetLabel = await boxOf(budget.locator('label'), 'budget label');
  const runsLabel = await boxOf(runs.locator('label'), 'maxRuns label');
  const budgetHint = await boxOf(budget.locator('p'), 'budget hint');
  const runsHint = await boxOf(runs.locator('p'), 'maxRuns hint');
  const budgetBox = await boxOf(budget, 'budget field');
  const runsBox = await boxOf(runs, 'maxRuns field');
  const dialog = await boxOf(page.locator('[role="dialog"]'), 'dialog');

  // 每个 FormField 内：label 与自己的 input 左缘对齐（栈对齐，不斜肩）。
  for (const [label, input] of [[budgetLabel, budgetInput], [runsLabel, runsInput]] as const) {
    expect(Math.abs(label.x - input.x)).toBeLessThanOrEqual(0.5);
    expect(label.y).toBeLessThan(input.y);
  }

  // 两列同轴：label 顶边同高、input 顶边同高；2 列 grid 里 input 等宽等高、分列不重叠。
  expect(Math.abs(budgetLabel.y - runsLabel.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(budgetInput.y - runsInput.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(budgetInput.width - runsInput.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(budgetInput.height - runsInput.height)).toBeLessThanOrEqual(0.5);
  expect(runsInput.x).toBeGreaterThan(budgetInput.x + budgetInput.width);

  // hint 完整落在自己的 field 盒内（不被 grid 裁切、不串列）。
  for (const [hint, field] of [[budgetHint, budgetBox], [runsHint, runsBox]] as const) {
    expect(hint.x).toBeGreaterThanOrEqual(field.x - 0.5);
    expect(hint.y).toBeGreaterThanOrEqual(field.y - 0.5);
    expect(hint.x + hint.width).toBeLessThanOrEqual(field.x + field.width + 0.5);
    expect(hint.y + hint.height).toBeLessThanOrEqual(field.y + field.height + 0.5);
  }

  // 两个 field 都不溢出 modal（含 1px 渲染容差）。
  for (const field of [budgetBox, runsBox]) {
    expect(field.x).toBeGreaterThanOrEqual(dialog.x - 1);
    expect(field.y).toBeGreaterThanOrEqual(dialog.y - 1);
    expect(field.x + field.width).toBeLessThanOrEqual(dialog.x + dialog.width + 1);
    expect(field.y + field.height).toBeLessThanOrEqual(dialog.y + dialog.height + 1);
  }
}

async function openAdvancedTab(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /高级选项/ }).click();
  await expect(page.getByTestId('cron-budget-limit-input')).toBeVisible({ timeout: 10_000 });
}

test('编辑器额度字段：已有任务各状态的几何与可见校验（含已运行计数提示）', async ({ page }) => {
  await waitForAppReady(page);
  const jobName = `额度截图任务 ${new Date().toISOString().slice(14, 19)}`;
  await seedJobWithTwoRuns(page, jobName);

  // 打开自动化中心 → 选中种入的任务 → 编辑 → 高级选项
  await page.getByTestId('sidebar-capability-automation').click();
  await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: jobName }).click();
  await page.getByTestId('cron-center-panel').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  await openAdvancedTab(page);

  // ── 状态 A：已有任务 maxRuns 3 / runCount 2 →「已运行 2/3 次」+ 完整几何 ──
  await expect(page.getByText(/已运行 2\/3 次/)).toBeVisible();
  await expect(page.getByTestId('cron-budget-limit-input')).toHaveValue('0.5');
  await expect(page.getByTestId('cron-maxruns-limit-input')).toHaveValue('3');
  await assertBudgetFieldsGeometry(page);
  // 几何拍完再装传感器：modal 开场动画不计入 after-interactive 位移。
  const geometrySensor: GeometrySensor = await installGeometrySensor(page);
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-budget-editor-existing-2of3.png') });
  await geometrySensor.markInteractive();
  await geometrySensor.assertClean();

  const budgetInput = page.getByTestId('cron-budget-limit-input');
  const runsInput = page.getByTestId('cron-maxruns-limit-input');
  const saveButton = page.getByRole('dialog').getByRole('button', { name: '保存修改' });
  const formError = page.getByRole('dialog').locator('.text-badge-danger');

  // ── 状态 B：清空（两个都不限）──
  await budgetInput.fill('');
  await runsInput.fill('');
  await expect(budgetInput).toHaveValue('');
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-budget-editor-empty.png') });

  // ── 状态 C：填合法值 ──
  await budgetInput.fill('0.01');
  await runsInput.fill('5');
  await expect(runsInput).toHaveValue('5');
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-budget-editor-filled.png') });

  // ── 状态 D/E/F：次数上限非法（0 / 1.5 / -1）→ 保存必须给出可见的中文校验错 ──
  for (const [index, value] of ['0', '1.5', '-1'].entries()) {
    await budgetInput.fill('0.5');
    await runsInput.fill(value);
    await saveButton.click();
    await expect(formError.first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOT_DIR, `cron-budget-editor-invalid-maxruns-${index}.png`) });
    await expect(formError.first()).toContainText(MAX_RUNS_VALIDATION_MESSAGE);
  }

  // ── 状态 G：预算非法（-1）──
  await budgetInput.fill('-1');
  await runsInput.fill('3');
  await saveButton.click();
  await expect(formError.first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-budget-editor-invalid-budget.png') });
  await expect(formError.first()).toContainText(BUDGET_VALIDATION_MESSAGE);

  // 校验挡下时不应真的发出更新：任务定义保持 maxRuns 3 / budget 0.5。
  const jobs = await cronDomain(page, 'listJobs', {}) as Array<{ name: string; maxRuns: number | null; maxRunBudget: number | null }>;
  const current = jobs.find((candidate) => candidate.name === jobName);
  expect(current?.maxRuns).toBe(3);
  expect(current?.maxRunBudget).toBe(0.5);
});

test('新建任务的额度字段：空态 + 通用 hint（不带已运行计数）', async ({ page }) => {
  await waitForAppReady(page);
  await page.getByTestId('sidebar-capability-automation').click();
  await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('cron-center-panel').getByText('新建', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText('手动配置', { exact: true }).click();
  await openAdvancedTab(page);

  await expect(page.getByTestId('cron-budget-limit-input')).toHaveValue('');
  await expect(page.getByTestId('cron-maxruns-limit-input')).toHaveValue('');
  // 新建（无既有计数）：hint 是通用文案，不显示「已运行 x/y 次」。
  await expect(page.getByText(/已运行 \d+\/\d+ 次/)).toHaveCount(0);
  await expect(page.getByText('到数自动停用并通知；重新启用后计数清零。留空为不限。')).toBeVisible();
  await assertBudgetFieldsGeometry(page);
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-budget-editor-new-job-empty.png') });
});
