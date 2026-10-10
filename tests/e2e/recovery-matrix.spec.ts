// Recovery matrix: one cell per failure class, run one at a time (workers: 1).
// Playwright `mode: 'serial'` would skip every later cell after the first hard-invariant
// failure, so this file stays in default mode and still shares one server handle.
// Assertions are the hard invariants only (server returns, a ledger recovery
// action is visible, lineage is not quarantined). The full visible list is
// recorded; starter cards and expand toggles do not count as an exit.
import { expect, test, type Page } from './fixtures/axeTest';
import { mkdir } from 'node:fs/promises';

import { dismissFirstRunDialogs } from './firstRunDialogs';
import {
  allocatePort,
  assertRecoveryInvariants,
  CELL_LOG,
  makeFreshDirs,
  orderMatches,
  readSessionDb,
  recordCell,
  restartServer,
  seedOrphanToolCall,
  shotPath,
  SHOT_DIR,
  startServer,
  stopServer,
  type CellRecord,
  type DbReadback,
  type ServerHandle,
} from './fixtures/recoveryMatrixHost';

test.describe.configure({ mode: 'default' });
test.skip(
  process.env.CODE_AGENT_E2E_RECOVERY_MATRIX !== '1',
  '需要 CODE_AGENT_E2E_RECOVERY_MATRIX=1（自管 webServer，不进默认 e2e 批）',
);
test.setTimeout(240_000);

const RECOVERY_TESTIDS = [
  'stream-interruption-decision',
  'durable-resume-notice',
  'continue-run-button',
  'user-message-send-failed',
  'tool-error-retry',
  'tool-error-copy',
  'overview-run-header-interrupt',
  'user-question-card',
  'decision-slot',
  'session-member-bar-collapsed',
  'member-conversation-view',
  'stream-resume-status',
  'stream-resume-note',
  'stream-break-kept-segment',
  'rate-limited-error-line',
  'chat-welcome-title',
];

let current: ServerHandle | null = null;

// cells.jsonl is truncated by the npm script, not here: a red cell restarts the
// worker, and beforeAll would wipe rows the previous worker already appended.
test.beforeAll(async () => {
  await mkdir(SHOT_DIR, { recursive: true });
});

test.afterEach(async () => {
  if (!current) return;
  await stopServer(current).catch(() => undefined);
  current = null;
});

test('A-continue app restart then 继续', async ({ page }) => {
  const parked = await parkApproval(page, 'A-continue');
  const restarted = await restartServer(requireServer('A-continue'));
  current = restarted;
  await installSettingsStub(page);
  await preparePage(page, restarted.baseUrl);
  await openSession(page, parked.sessionId);
  const before = await revealApproval(page, parked.taskId);
  await page.screenshot({ path: shotPath('A-continue'), fullPage: false });
  const clicked = await clickContinue(page);
  await page.waitForTimeout(2_000);
  const after = await captureSurface(page);
  const apiIds = await messageIds(page, restarted, parked.sessionId);
  const finished = await finishReadback(restarted, parked.sessionId, apiIds);
  current = null;
  await publish({
    cell: 'A-continue',
    injection: 'E2E_BACKGROUND_APPROVAL delegate_task, SIGKILL, restart same data dir',
    statusText: before.statusText,
    actions: before.actions,
    actionTaken: clicked ?? '继续 not visible',
    result: after.statusText || '(no status text after click)',
    screenshot: 'test-results/recovery-matrix/A-continue.png',
    notes: `memberRevealed=${before.revealedMember}`,
    ...finished,
    gap: mergeGap(finished.gap, missingRecoveryGap(before.actions)),
  }, true, false);
});

test('A-abandon app restart then 放弃', async ({ page }) => {
  const parked = await parkApproval(page, 'A-abandon');
  const restarted = await restartServer(requireServer('A-abandon'));
  current = restarted;
  await installSettingsStub(page);
  await preparePage(page, restarted.baseUrl);
  await openSession(page, parked.sessionId);
  const before = await revealApproval(page, parked.taskId);
  await page.screenshot({ path: shotPath('A-abandon'), fullPage: false });
  const clicked = await clickNamed(page, '放弃');
  await page.waitForTimeout(2_000);
  const after = await captureSurface(page);
  const apiIds = await messageIds(page, restarted, parked.sessionId);
  const finished = await finishReadback(restarted, parked.sessionId, apiIds);
  current = null;
  await publish({
    cell: 'A-abandon',
    injection: 'E2E_BACKGROUND_APPROVAL delegate_task, SIGKILL, restart same data dir',
    statusText: before.statusText,
    actions: before.actions,
    actionTaken: clicked ? '放弃' : '放弃 not visible',
    result: after.statusText || '(no status text after click)',
    screenshot: 'test-results/recovery-matrix/A-abandon.png',
    notes: `memberRevealed=${before.revealedMember}`,
    ...finished,
    gap: mergeGap(finished.gap, missingRecoveryGap(before.actions)),
  }, true, false);
});

test('B1 provider failure exhausts stream-break retries', async ({ page }) => {
  current = await boot('B1', { extraEnv: { CODE_AGENT_E2E_STREAM_BREAK_FAILURES: '5' } });
  const sessionId = await openComposer(page, current, 'B1 断流耗尽');
  await sendComposer(page, '请分两段回答这件事：E2E_STREAM_BREAK_RETRY');
  const failed = await waitForSurface(page, (surface) => surface.actions.some((action) => action.includes('重试')), 90_000);
  const before = failed ?? await captureSurface(page);
  await page.screenshot({ path: shotPath('B1-exhausted'), fullPage: false });
  const clicked = await clickMatching(page, /重试/);
  await page.waitForTimeout(8_000);
  const retried = await captureSurface(page);
  await recordCell({
    cell: 'B1-exhausted',
    injection: 'E2E_STREAM_BREAK_RETRY CODE_AGENT_E2E_STREAM_BREAK_FAILURES=5',
    statusText: before.statusText,
    actions: before.actions,
    actionTaken: clicked ?? '重试 not visible',
    result: retried.statusText || '(no status text after retry)',
    screenshot: 'test-results/recovery-matrix/B1-exhausted.png',
  });
  let exhaustedError: string | null = null;
  try {
    assertRecoveryInvariants({
      cell: 'B1-exhausted',
      injectable: true,
      actions: recoveryActions(before.actions),
      autoResolved: false,
    });
  } catch (error) {
    exhaustedError = error instanceof Error ? error.message : String(error);
  }

  const restartedServer = await restartServer(requireServer('B1'), { extraEnv: { CODE_AGENT_E2E_STREAM_BREAK_FAILURES: '5' } });
  current = restartedServer;
  await installSettingsStub(page);
  await preparePage(page, restartedServer.baseUrl);
  await openSession(page, sessionId);
  const restarted = await settleSurface(page);
  const clickedAgain = await clickMatching(page, /重试/);
  await page.waitForTimeout(8_000);
  const afterRestart = await captureSurface(page);
  await page.screenshot({ path: shotPath('B1-restart'), fullPage: false });
  const apiIds = await messageIds(page, restartedServer, sessionId);
  const finished = await finishReadback(restartedServer, sessionId, apiIds);
  current = null;
  let restartError: string | null = null;
  try {
    await publish({
      cell: 'B1-restart',
      injection: 'same data dir, SIGKILL restart resets the process-local failure counter to 5',
      statusText: restarted.statusText,
      actions: restarted.actions,
      actionTaken: clickedAgain ?? '重试 not visible',
      result: afterRestart.statusText || '(no status text after restart retry)',
      screenshot: 'test-results/recovery-matrix/B1-restart.png',
      ...finished,
    }, true, afterRestart.statusText.includes('E2E_STREAM_BREAK_PART2'));
  } catch (error) {
    restartError = error instanceof Error ? error.message : String(error);
  }
  const errors = [exhaustedError, restartError].filter((item): item is string => item !== null);
  if (errors.length > 0) throw new Error(errors.join('\n'));
});

test('B2 provider base URL on a closed local port', async ({ page }) => {
  const closedPort = await allocatePort();
  current = await boot('B2', {
    localModel: false,
    isolateLoopback: true,
    closedBaseUrlPort: closedPort,
  });
  await openComposer(page, current, 'B2 关闭端口');
  await sendComposer(page, '说一句你好');
  // Welcome starter cards are already on screen; wait for the failure banner.
  const surface = await waitForSurface(
    page,
    (candidate) => candidate.actions.some((action) => /重试|切换模型/.test(action))
      || candidate.statusText.includes('role=alert'),
    90_000,
  ) ?? await captureSurface(page);
  await page.screenshot({ path: shotPath('B2-closed-port'), fullPage: false });
  const leftMachine = /api\.openai\.com|open\.bigmodel|api\.anthropic\.com|api\.deepseek\.com|api\.moonshot\.cn|api\.kimi\.com|api\.minimax\.chat|api\.perplexity\.ai|api\.x\.ai|openrouter\.ai|generativelanguage\.googleapis|api\.groq\.com|dashscope|volces\.com|xiaomimimo|api\.longcat\.chat|api\.0ki\.cn|localhost:11434/.test(current.output());
  await publish({
    cell: 'B2-closed-port',
    injection: `CODE_AGENT_E2E_LOCAL_AGENT_MODEL unset; models.providers.openai.baseUrl=http://127.0.0.1:${closedPort}/v1; placeholder key`,
    statusText: surface.statusText,
    actions: surface.actions,
    actionTaken: 'none — record the surfaced failure',
    result: leftMachine ? 'server log mentioned a real provider host' : surface.statusText || '(empty surface)',
    screenshot: 'test-results/recovery-matrix/B2-closed-port.png',
    gap: leftMachine ? 'closed-port run mentioned a real provider host' : null,
    notes: 'Config key used: models.providers.openai.baseUrl',
  }, true, false);
});

test('C-allow parked AskUserQuestion', async ({ page }) => {
  const parked = await parkApproval(page, 'C-allow');
  const before = await captureSurface(page);
  await page.screenshot({ path: shotPath('C-allow'), fullPage: false });
  const clicked = await answerApproval(page, 'allow');
  const completed = await waitForText(page, 'E2E background approval completed', 45_000);
  await publish({
    cell: 'C-allow',
    injection: 'E2E_BACKGROUND_APPROVAL via delegate_task',
    statusText: before.statusText,
    actions: before.actions,
    actionTaken: clicked ?? '回答 · 允许 not visible',
    result: completed ? 'E2E background approval completed' : (await captureSurface(page)).statusText,
    screenshot: 'test-results/recovery-matrix/C-allow.png',
    notes: `session ${parked.sessionId}`,
  }, true, completed);
});

test('C-deny parked AskUserQuestion', async ({ page }) => {
  const parked = await parkApproval(page, 'C-deny');
  const before = await captureSurface(page);
  await page.screenshot({ path: shotPath('C-deny'), fullPage: false });
  const clicked = await answerApproval(page, 'deny');
  await page.waitForTimeout(3_000);
  const after = await captureSurface(page);
  const hidden = !(await page.getByText('允许后台任务继续完成验收吗').isVisible().catch(() => false));
  await publish({
    cell: 'C-deny',
    injection: 'E2E_BACKGROUND_APPROVAL via delegate_task',
    statusText: before.statusText,
    actions: before.actions,
    actionTaken: clicked ?? '回答 · 拒绝 not visible',
    result: hidden ? `question hidden; ${after.statusText}` : after.statusText,
    screenshot: 'test-results/recovery-matrix/C-deny.png',
    notes: `session ${parked.sessionId}`,
  }, true, hidden);
});

test('C-foreground E2E_SNAPSHOT_REPLAY_WRITE decision slot', async ({ page }) => {
  current = await boot('C-write');
  await openComposer(page, current, 'C 前台写权限');
  await sendComposer(page, '写一张便签：E2E_SNAPSHOT_REPLAY_WRITE');
  const slot = await waitForTestId(page, 'decision-slot', 20_000);
  const completed = await waitForText(page, 'E2E snapshot replay write completed', slot ? 5_000 : 20_000);
  const surface = await captureSurface(page);
  await page.screenshot({ path: shotPath('C-foreground-write'), fullPage: false });
  await publish({
    cell: 'C-foreground-write',
    injection: 'E2E_SNAPSHOT_REPLAY_WRITE through the composer',
    statusText: surface.statusText,
    actions: surface.actions,
    actionTaken: 'none — record whether decision-slot appears; do not force it',
    result: slot
      ? `decision-slot visible; completed=${completed}`
      : `decision-slot did not appear in web mode; completed=${completed}`,
    screenshot: 'test-results/recovery-matrix/C-foreground-write.png',
    notes: slot ? 'decision-slot appeared' : 'decision-slot did not appear in web mode',
  }, true, completed || slot);
});

test('D1 orphan tool call without a begin row', async ({ page }) => {
  await runOrphanCell(page, 'D1', 'D1-no-begin');
});

test('D2 orphan tool call with a begin row', async ({ page }) => {
  await runOrphanCell(page, 'D2', 'D2-with-begin');
});

test('E stream break keeps the segment and continues', async ({ page }) => {
  current = await boot('E');
  const sessionId = await openComposer(page, current, 'E 断流续接');
  await sendComposer(page, '请分两段回答这件事：E2E_STREAM_BREAK_RETRY');
  const signal = await waitForTestId(page, 'stream-resume-status', 30_000);
  const signalSurface = await captureSurface(page);
  const part2 = await waitForText(page, 'E2E_STREAM_BREAK_PART2', 60_000);
  const kept = await page.getByTestId('stream-break-kept-segment').isVisible().catch(() => false);
  await page.reload();
  await preparePage(page, current.baseUrl);
  await openSession(page, sessionId);
  const reloaded = await captureSurface(page);
  const part2AfterReload = await page.getByText('E2E_STREAM_BREAK_PART2').isVisible().catch(() => false);
  await page.screenshot({ path: shotPath('E-stream-break'), fullPage: false });
  await publish({
    cell: 'E-stream-break',
    injection: 'E2E_STREAM_BREAK_RETRY default CODE_AGENT_E2E_STREAM_BREAK_FAILURES (1)',
    statusText: [
      `signal=${signal ? signalSurface.statusText : '(status line not seen)'}`,
      `keptSegment=${kept}`,
      `part2=${part2}`,
      `reload=${reloaded.statusText}`,
      `part2AfterReload=${part2AfterReload}`,
    ].join('\n'),
    actions: [...signalSurface.actions, ...reloaded.actions],
    actionTaken: 'none — automatic continuation',
    result: part2AfterReload ? 'reload shows E2E_STREAM_BREAK_PART2' : reloaded.statusText || '(reload empty)',
    screenshot: 'test-results/recovery-matrix/E-stream-break.png',
  }, true, part2 || part2AfterReload);
});

test('F empty final is not injectable today', async () => {
  await publish({
    cell: 'F-empty-final',
    injection: 'not injectable today',
    statusText: '',
    actions: [],
    actionTaken: 'none',
    result: 'missing hook: a mock marker that returns empty content with finishReason stop. Hermetic substitute is vitest tests/unit/services/neoTagRuntime.test.ts and tests/unit/services/neoTagContinuation.test.ts.',
    screenshot: 'n/a',
    notes: 'e2eLocalAgentModel.ts has no empty-final marker; adding one is out of scope',
  }, false, false);
});

async function runOrphanCell(page: Page, variant: 'D1' | 'D2', cell: string): Promise<void> {
  const booted = await boot(cell);
  current = booted;
  await stopServer(booted);
  const seeded = await seedOrphanToolCall(booted.dirs.dataDir, variant);
  const restarted = await startServer({ dirs: booted.dirs, port: booted.port });
  current = restarted;
  await installSettingsStub(page);
  await preparePage(page, restarted.baseUrl);
  await openSession(page, seeded.sessionId);
  const expandedGroup = await expandToolGroup(page);
  await page.getByTestId('tool-error-retry').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  const row = page.getByTestId('tool-call-row-bash').or(page.getByTestId('tool-call-row-Bash'));
  if (await row.first().isVisible().catch(() => false)) await row.first().click();
  const surface = await settleSurface(page);
  const retry = page.getByTestId('tool-error-retry');
  let actionTaken = expandedGroup ? 'expanded tool group; tool-error-retry not visible' : 'none';
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    actionTaken = 'tool-error-retry';
  } else if (await clickContinue(page)) {
    actionTaken = '继续';
  }
  await page.waitForTimeout(3_000);
  const after = await captureSurface(page);
  await page.screenshot({ path: shotPath(cell), fullPage: false });
  const apiIds = await messageIds(page, restarted, seeded.sessionId);
  const finished = await finishReadback(restarted, seeded.sessionId, apiIds);
  current = null;
  const expected = variant === 'D1' ? 'NOT_STARTED' : 'OUTCOME_UNKNOWN';
  await publish({
    cell,
    injection: variant === 'D1'
      ? 'repository seed: assistant bash tool call, no tool_execution_events begin, session status running, then boot'
      : 'repository seed: assistant bash tool call plus ToolExecutionEventRepository.appendBegin, then boot',
    statusText: surface.statusText,
    actions: surface.actions,
    actionTaken,
    result: after.statusText || '(no status text after action)',
    screenshot: `test-results/recovery-matrix/${cell}.png`,
    notes: `ticket names ${expected}; startupMaintenance no longer splits begin-row wording (one interrupted placeholder). Recorded text is verbatim`,
    ...finished,
  }, true, false);
}

async function boot(
  label: string,
  options: Omit<Parameters<typeof startServer>[0], 'dirs'> = {},
): Promise<ServerHandle> {
  const dirs = await makeFreshDirs(label);
  try {
    return await startServer({ dirs, ...options });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cell ${label} server did not come back healthy: ${detail}`, { cause: error });
  }
}

function requireServer(label: string): ServerHandle {
  if (!current) throw new Error(`cell ${label} lost its server`);
  return current;
}

async function parkApproval(page: Page, label: string): Promise<{ sessionId: string; taskId: string }> {
  current = await boot(label);
  await installSettingsStub(page);
  await preparePage(page, current.baseUrl);
  const token = await getAuthToken(page);
  const sessionId = await createSession(current.baseUrl, token, label);
  // Reload once so the sidebar lists the session, then subscribe again BEFORE the
  // child asks. The question is an SSE event; reloading after it arrives drops the
  // card, and the member view does not render one.
  await page.reload();
  await preparePage(page, current.baseUrl);
  await openSession(page, sessionId);
  const delegated = await api(current.baseUrl, token, 'POST', '/api/dev/exec-tool', {
    tool: 'delegate_task',
    sessionId,
    allowWrite: true,
    params: {
      title: '后台审批验收',
      short_name: '审批任务',
      lane_key: 'acceptance-approval',
      submission_key: `recovery-${label}-${Date.now()}`,
      prompt: 'E2E_BACKGROUND_APPROVAL',
    },
  });
  expect(delegated.ok, `delegate_task failed: ${delegated.status} ${delegated.text.slice(0, 400)}`).toBe(true);
  const delegatedBody = JSON.parse(delegated.text) as { success?: boolean; output?: unknown; error?: unknown };
  expect(delegatedBody.success, `delegate_task error: ${JSON.stringify(delegatedBody.error)}`).toBe(true);
  const taskId = parseDelegatedTaskId(delegatedBody.output);
  if (!taskId) throw new Error(`task id missing in delegate output: ${String(delegatedBody.output).slice(0, 400)}`);
  const card = page.getByTestId('user-question-card').first();
  const collapsed = page.getByTestId('user-question-collapsed').first();
  const appeared = await card.waitFor({ state: 'visible', timeout: 45_000 }).then(() => true).catch(() => false);
  if (!appeared && await collapsed.isVisible().catch(() => false)) {
    await collapsed.click();
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  return { sessionId, taskId };
}

function parseDelegatedTaskId(output: unknown): string | null {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  return text.match(/「[^」]*」\(([^()\s]+)\)/)?.[1] ?? null;
}

async function expandToolGroup(page: Page): Promise<boolean> {
  const head = page.getByTestId('tool-group-head-label').first();
  if (!(await head.isVisible().catch(() => false))) return false;
  const expanded = await head.evaluate((element) => element.closest('button')?.getAttribute('aria-expanded'));
  if (expanded !== 'true') await head.click();
  return true;
}

async function openParkedMember(page: Page, taskId: string): Promise<void> {
  const bar = page.getByTestId('session-member-bar-collapsed');
  await expect(bar).toBeVisible({ timeout: 4_000 });
  await bar.click();
  const openMember = page.getByTestId(`agents-panel-open-${taskId}`);
  await expect(openMember).toBeVisible({ timeout: 4_000 });
  await openMember.click();
  await expect(page.getByTestId('member-conversation-view')).toBeVisible({ timeout: 15_000 });
}

async function revealApproval(
  page: Page,
  taskId: string,
): Promise<{ statusText: string; actions: string[]; revealedMember: boolean }> {
  const parent = await settleSurface(page);
  const hasChoice = parent.actions.some((action) => action.includes('继续') || action.includes('放弃'));
  if (hasChoice) return { ...parent, revealedMember: false };
  try {
    await openParkedMember(page, taskId);
  } catch {
    return { ...parent, revealedMember: false };
  }
  const card = page.getByTestId('user-question-card').first();
  if (!(await card.isVisible().catch(() => false))) {
    const back = page.getByTestId('member-view-back');
    if (await back.isVisible().catch(() => false)) await back.click();
  }
  const inner = await settleSurface(page);
  const actions = [...parent.actions];
  for (const action of inner.actions) {
    if (!actions.includes(action)) actions.push(action);
  }
  return {
    statusText: [parent.statusText, inner.statusText].filter(Boolean).join('\n'),
    actions,
    revealedMember: true,
  };
}

async function openComposer(page: Page, server: ServerHandle, title: string): Promise<string> {
  await installSettingsStub(page);
  await preparePage(page, server.baseUrl);
  const token = await getAuthToken(page);
  const sessionId = await createSession(server.baseUrl, token, title);
  await openSession(page, sessionId);
  await expect(page.getByTestId('chat-composer-textarea')).toBeVisible({ timeout: 15_000 });
  return sessionId;
}

async function preparePage(page: Page, baseUrl: string): Promise<void> {
  const ssePromise = page.waitForResponse(
    (response) => response.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });
  await ssePromise;
  await dismissFirstRunDialogs(page);
  await dismissExtra(page);
  await page.waitForTimeout(1_500);
  await dismissFirstRunDialogs(page);
  await dismissExtra(page);
}

async function dismissExtra(page: Page): Promise<void> {
  for (const name of ['关闭', '信任并加载', '返回应用']) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
    }
  }
}

async function installSettingsStub(page: Page): Promise<void> {
  await page.unroute('**/api/domain/settings/get').catch(() => undefined);
  await page.route('**/api/domain/settings/get', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          models: {
            default: 'openai',
            providers: {
              openai: { enabled: true, apiKey: 'sk-e2e-placeholder', model: 'gpt-4o' },
            },
          },
        },
      }),
    });
  });
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => (
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined
  ));
  if (!token) throw new Error('window.__CODE_AGENT_TOKEN__ missing');
  return token;
}

async function createSession(baseUrl: string, token: string, title: string): Promise<string> {
  const response = await api(baseUrl, token, 'POST', '/api/sessions', { title });
  expect(response.ok, `create session failed: ${response.status} ${response.text.slice(0, 300)}`).toBe(true);
  const body = JSON.parse(response.text) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error('create session returned no id');
  return id;
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  const item = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('chat-composer-textarea');
  await composer.fill(text);
  await composer.press('Enter');
}

async function messageIds(page: Page, server: ServerHandle, sessionId: string): Promise<string[]> {
  const token = await getAuthToken(page);
  const response = await api(server.baseUrl, token, 'GET', `/api/sessions/${sessionId}/messages`);
  if (!response.ok) return [];
  const body = JSON.parse(response.text) as {
    data?: { messages?: Array<{ id?: string }> } | Array<{ id?: string }>;
    messages?: Array<{ id?: string }>;
  };
  const messages = Array.isArray(body.data) ? body.data : body.data?.messages ?? body.messages ?? [];
  return messages.map((message) => message.id).filter((id): id is string => typeof id === 'string');
}

async function api(
  baseUrl: string,
  token: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function redactHome(text: string): string {
  return text.replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}

async function finishReadback(
  server: ServerHandle,
  sessionId: string,
  apiIds: string[],
): Promise<{ dbReadback: DbReadback; consistency: string; gap: string | null }> {
  await stopServer(server);
  try {
    const dbReadback = await readSessionDb(server.dirs.dataDir, sessionId);
    const order = orderMatches(apiIds, dbReadback.messages.map((message) => message.id));
    const consistency = redactHome([
      `orderMatch=${order}`,
      `apiIds=${apiIds.length}`,
      `roles=${dbReadback.rolesInOrder.join('>')}`,
      `duplicate=${dbReadback.duplicateAssistantOrTool}`,
      `events=${dbReadback.sessionEvents.map((event) => `${event.seq}:${event.type}`).join(',') || '-'}`,
      `durable=${dbReadback.durableRuns.map((run) => `${run.sessionId}:${run.status}/${run.interruptCause ?? '-'}`).join(',') || '-'}`,
      `lineage=${dbReadback.lineage.map((entry) => `${entry.sessionId}:${entry.status}:${entry.issueCodes.join('+') || '-'}:${entry.replay}`).join(';') || '-'}`,
      dbReadback.lineageError ? `lineageError=${dbReadback.lineageError}` : '',
    ].filter(Boolean).join(' '));
    const gap = !order
      ? 'UI message order does not match DB order'
      : dbReadback.duplicateAssistantOrTool
        ? 'duplicate assistant/tool message content'
        : null;
    return { dbReadback, consistency, gap };
  } catch (error) {
    const text = redactHome(error instanceof Error ? error.message : String(error));
    const dbReadback: DbReadback = {
      sessionId,
      messages: [],
      rolesInOrder: [],
      duplicateAssistantOrTool: false,
      sessionEvents: [],
      durableRuns: [],
      lineage: [],
      lineageError: text,
    };
    return {
      dbReadback,
      consistency: `readbackError=${text}`,
      gap: `db readback failed: ${text}`,
    };
  }
}

function mergeGap(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((part): part is string => Boolean(part && part.trim())).join('; ');
  return text.length > 0 ? text : null;
}

// 台账恢复动作及其界面原文。欢迎卡、组头展开不算。
const RECOVERY_ACTION = /继续|放弃|丢弃|重试|切换模型|换模型|允许|拒绝|批准|回答|允许一次/;

function recoveryActions(actions: string[]): string[] {
  return actions.filter((action) => RECOVERY_ACTION.test(action));
}

function missingRecoveryGap(actions: string[]): string | null {
  if (recoveryActions(actions).length > 0) return null;
  return '继续/放弃/丢弃/重试/切换模型/换模型/允许/拒绝/批准/回答/允许一次 were not visible';
}

async function publish(
  record: CellRecord,
  injectable: boolean,
  autoResolved: boolean,
): Promise<void> {
  await recordCell(record);
  assertRecoveryInvariants({
    cell: record.cell,
    injectable,
    actions: recoveryActions(record.actions),
    autoResolved,
    readback: record.dbReadback,
  });
}

async function captureSurface(page: Page): Promise<{ statusText: string; actions: string[] }> {
  return page.evaluate((testIds) => {
    const chunks: string[] = [];
    const actions: string[] = [];
    const seen = new Set<string>();
    const pushAction = (label: string | null | undefined): void => {
      const text = (label ?? '').replace(/\s+/g, ' ').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      actions.push(text);
    };
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    for (const id of testIds) {
      for (const element of document.querySelectorAll(`[data-testid="${id}"]`)) {
        if (!visible(element)) continue;
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) chunks.push(`[${id}] ${text}`);
        if (element.tagName === 'BUTTON') pushAction(element.getAttribute('aria-label') || text);
        for (const button of element.querySelectorAll('button')) {
          if (!visible(button)) continue;
          pushAction(button.getAttribute('aria-label') || button.textContent);
        }
      }
    }
    for (const head of document.querySelectorAll('[data-testid="tool-group-head-label"]')) {
      if (!visible(head)) continue;
      const button = head.closest('button');
      const text = ((button as HTMLElement | null)?.innerText || (head as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(`[tool-group-head] ${text}`);
      if (button && visible(button)) pushAction(text);
    }
    const welcome = document.querySelector('[data-testid="chat-welcome-title"]');
    if (welcome && visible(welcome)) {
      const block = welcome.closest('.max-w-3xl') ?? welcome.parentElement?.parentElement ?? welcome;
      const text = ((block as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(`[chat-welcome] ${text}`);
      for (const button of block.querySelectorAll('button')) {
        if (!visible(button)) continue;
        const label = button.getAttribute('aria-label') || (button as HTMLElement).innerText;
        pushAction(label);
      }
    }
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      if (!visible(alert)) continue;
      const text = (alert.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) chunks.push(`[role=alert] ${text}`);
      for (const button of alert.querySelectorAll('button')) {
        if (visible(button)) pushAction(button.textContent);
      }
    }
    return { statusText: chunks.join('\n'), actions };
  }, RECOVERY_TESTIDS);
}

async function settleSurface(page: Page): Promise<{ statusText: string; actions: string[] }> {
  const deadline = Date.now() + 8_000;
  let latest = await captureSurface(page);
  while (Date.now() < deadline) {
    if (latest.actions.length > 0 || latest.statusText.length > 0) return latest;
    await page.waitForTimeout(400);
    latest = await captureSurface(page);
  }
  return latest;
}

async function waitForSurface(
  page: Page,
  predicate: (surface: { statusText: string; actions: string[] }) => boolean,
  timeoutMs: number,
): Promise<{ statusText: string; actions: string[] } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const surface = await captureSurface(page);
    if (predicate(surface)) return surface;
    await page.waitForTimeout(500);
  }
  return null;
}

async function waitForText(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  return page.getByText(text).first().waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function waitForTestId(page: Page, testId: string, timeoutMs: number): Promise<boolean> {
  return page.getByTestId(testId).first().waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function clickMatching(page: Page, pattern: RegExp): Promise<string | null> {
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = buttons.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = ((await candidate.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!pattern.test(text)) continue;
    await candidate.click();
    return text;
  }
  return null;
}

async function answerApproval(page: Page, decision: 'allow' | 'deny'): Promise<string | null> {
  const card = page.getByTestId('user-question-card').first();
  if (decision === 'deny') {
    const deny = card.getByRole('button', { name: '回答 · 拒绝', exact: true });
    if (await deny.isVisible().catch(() => false)) {
      await deny.click();
      return '回答 · 拒绝';
    }
    return (await clickNamed(page, '回答 · 拒绝')) ? '回答 · 拒绝' : null;
  }
  const choices = card.getByRole('button', { name: /允许/ });
  const count = await choices.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = choices.nth(index);
    const text = ((await candidate.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (text.startsWith('回答')) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click();
    break;
  }
  const allow = card.getByRole('button', { name: '回答 · 允许', exact: true });
  if (await allow.isVisible().catch(() => false)) {
    await allow.click();
    return '回答 · 允许';
  }
  return null;
}

async function clickNamed(page: Page, name: string): Promise<boolean> {
  const scoped = page.getByTestId('user-question-card').getByRole('button', { name, exact: true });
  if (await scoped.first().isVisible().catch(() => false)) {
    await scoped.first().click();
    return true;
  }
  const button = page.getByRole('button', { name, exact: true });
  const count = await button.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = button.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }
  return false;
}

async function clickContinue(page: Page): Promise<string | null> {
  const byTestId = page.getByTestId('continue-run-button');
  if (await byTestId.isVisible().catch(() => false)) {
    await byTestId.click();
    return 'continue-run-button';
  }
  const row = page.getByTestId('stream-interruption-decision').getByRole('button', { name: '继续' });
  if (await row.isVisible().catch(() => false)) {
    await row.click();
    return 'stream-interruption-decision';
  }
  if (await clickNamed(page, '继续')) return '继续';
  return null;
}
