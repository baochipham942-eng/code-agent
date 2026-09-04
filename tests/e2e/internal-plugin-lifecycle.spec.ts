import { expect, test, type Page } from './fixtures/axeTest';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { dismissFirstRunDialogs } from './firstRunDialogs';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const packageRoot = path.join(repositoryRoot, 'packages/internal/evaluation-center');
const evidenceAssetsDir = path.resolve(
  repositoryRoot,
  '../../code-agent-private-archive/docs/evidence/assets',
);

const screenshots = {
  menu: path.join(evidenceAssetsDir, 'N-LOADER-L4-menu.png'),
  rendered: path.join(evidenceAssetsDir, 'N-LOADER-L4-rendered.png'),
  uninstalledMenu: path.join(evidenceAssetsDir, 'N-LOADER-L4-uninstalled-menu.png'),
  uninstalledPage: path.join(evidenceAssetsDir, 'N-LOADER-L4-uninstalled-page.png'),
} as const;

const realEvalScreenshots = {
  selection: path.join(evidenceAssetsDir, 'N-LOADER-L5-01-selection.png'),
  confirmation: path.join(evidenceAssetsDir, 'N-LOADER-L5-02-confirmation.png'),
  active: path.join(evidenceAssetsDir, 'N-LOADER-L5-03-active.png'),
  result: path.join(evidenceAssetsDir, 'N-LOADER-L5-04-result.png'),
  usage: path.join(evidenceAssetsDir, 'N-LOADER-L5-05-usage.png'),
  drawer: path.join(evidenceAssetsDir, 'N-LOADER-L5-06-drawer.png'),
  baseline: path.join(evidenceAssetsDir, 'N-LOADER-L5-07-baseline.png'),
} as const;

const realEvalEnabled = process.env.CODE_AGENT_REAL_EVAL_E2E === '1';
if (!realEvalEnabled) {
  process.stdout.write(
    'REAL_EVAL_E2E_SKIP=CODE_AGENT_REAL_EVAL_E2E is not 1; paid chatprobe evaluation is local opt-in only\n',
  );
}

type PackageResult<T> = { success: true; data: T } | { success: false; error: string };

interface PackagePreview {
  token: string;
  surface: string;
  sandbox: { passed: boolean; summary: string };
}

interface InstalledPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  state: string;
  toolNames: string[];
  surface: string;
  internalFeature?: {
    id: string;
    label: string;
    sdkVersion: { host: string; renderer: string };
    rendererEntry: string;
    rendererStyles: string;
    hostEntry: string;
    loadedHash?: string;
    builtFrom?: { appVersion: string; commit: string };
  };
}

interface CapturedEvalEvent {
  schemaVersion: number;
  type: string;
  runId: string;
  testId?: string;
  status?: string;
  usageStatus?: string;
  costUsd?: number;
  plannedCaseIds?: string[];
  config?: { split?: string; k?: number; model?: string; provider?: string };
  summary?: {
    passed?: number;
    failed?: number;
    completed?: boolean;
    plannedCaseIds?: string[];
  };
}

let currentZipPath: string;
let oldContractZipPath: string;
let builtManifest: InstalledPackage & { internalFeature: NonNullable<InstalledPackage['internalFeature']> };
let mutationDir: string;

async function invokeCommand<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ requestedChannel, requestedArgs }) => {
    const api = window.codeAgentAPI || window.electronAPI;
    if (!api) throw new Error('Code Agent command bridge is unavailable');
    const invoke = api.invoke as unknown as (channel: string, ...values: unknown[]) => Promise<unknown>;
    return invoke(requestedChannel, ...requestedArgs);
  }, { requestedChannel: channel, requestedArgs: args }) as Promise<T>;
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });
  await dismissFirstRunDialogs(page);
  const returnToApp = page.getByRole('button', { name: '返回应用' });
  await returnToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await returnToApp.isVisible().catch(() => false)) {
    await returnToApp.click();
    await expect(returnToApp).toBeHidden({ timeout: 10_000 });
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 20_000 });
}

async function readCapturedEvalEvents(page: Page): Promise<CapturedEvalEvent[]> {
  return page.evaluate(() => (
    (window as unknown as { __l5RealEvalEvents?: CapturedEvalEvent[] }).__l5RealEvalEvents ?? []
  ));
}

async function startCapturingEvalEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as {
      __l5RealEvalEvents?: CapturedEvalEvent[];
      __l5RealEvalUnsubscribe?: () => void;
    };
    state.__l5RealEvalEvents = [];
    const api = window.codeAgentAPI || window.electronAPI;
    if (!api?.on) throw new Error('Code Agent event bridge is unavailable');
    const eventApi = api as unknown as {
      on: (channel: string, listener: (event: unknown) => void) => () => void;
    };
    state.__l5RealEvalUnsubscribe = eventApi.on('evaluation:run-events', (event: unknown) => {
      state.__l5RealEvalEvents?.push(event as CapturedEvalEvent);
    });
  });
}

async function stopCapturingEvalEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __l5RealEvalUnsubscribe?: () => void };
    state.__l5RealEvalUnsubscribe?.();
    delete state.__l5RealEvalUnsubscribe;
  });
}

test.afterEach(async ({ page }) => {
  if (!realEvalEnabled) return;
  const events = await readCapturedEvalEvents(page).catch(() => []);
  const runStart = [...events].reverse().find((event) => event.type === 'run_start');
  if (!runStart || events.some((event) => event.runId === runStart.runId && event.type === 'run_end')) return;
  const abortResult = await invokeCommand<unknown>(
    page,
    'evaluation:abort-run',
    { runId: runStart.runId, reason: 'Playwright real-eval test ended before run_end' },
  ).catch((error: unknown) => ({ abortError: error instanceof Error ? error.message : String(error) }));
  process.stdout.write(`REAL_EVAL_CLEANUP_ABORT=${JSON.stringify({ runId: runStart.runId, abortResult })}\n`);
});

async function buildFreshPluginZips(): Promise<void> {
  await fs.mkdir(evidenceAssetsDir, { recursive: true });
  const result = await execFile('npm', ['--prefix', packageRoot, 'run', 'pack'], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packStdout = `${result.stdout}${result.stderr}`;
  process.stdout.write(packStdout);
  const packedLine = packStdout.split('\n').find((line) => line.includes('[evaluation-center] packed '));
  const packedMatch = packedLine?.match(/\[evaluation-center\] packed (.+) \(\d+ bytes\)$/u);
  if (!packedMatch) throw new Error('Fresh plugin pack did not report its zip path');
  currentZipPath = packedMatch[1];

  const currentArchive = await fs.readFile(currentZipPath);
  const zip = await JSZip.loadAsync(currentArchive);
  const manifestEntry = zip.file('plugin.json');
  if (!manifestEntry) throw new Error('Fresh plugin zip has no plugin.json');
  builtManifest = JSON.parse(await manifestEntry.async('string')) as typeof builtManifest;

  mutationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-plugin-old-contract-'));
  const oldManifest = structuredClone(builtManifest);
  oldManifest.internalFeature.sdkVersion.renderer = 'pending';
  zip.file('plugin.json', `${JSON.stringify(oldManifest, null, 2)}\n`);
  oldContractZipPath = path.join(mutationDir, 'evaluation-center-old-renderer-contract.zip');
  await fs.writeFile(
    oldContractZipPath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );

  const currentStat = await fs.stat(currentZipPath);
  const oldStat = await fs.stat(oldContractZipPath);
  process.stdout.write(`FRESH_ZIP=${currentZipPath} bytes=${currentStat.size}\n`);
  process.stdout.write(`OLD_CONTRACT_ZIP=${oldContractZipPath} bytes=${oldStat.size}\n`);
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a non-admin web port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(baseUrl: string, child: ChildProcess): Promise<void> {
  let lastError = 'server did not respond';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Non-admin server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Non-admin server failed to start: ${lastError}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function curlRaw(url: string): Promise<{ statusLine: string; raw: string }> {
  const result = await execFile('curl', ['--silent', '--show-error', '--path-as-is', '--dump-header', '-', url], {
    cwd: repositoryRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = String(result.stdout);
  return { statusLine: raw.split(/\r?\n/u)[0] ?? '', raw };
}

async function startNonAdminServer(installedDataDir: string): Promise<{
  child: ChildProcess;
  baseUrl: string;
  logs: () => string;
}> {
  const port = await getFreePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-plugin-non-admin-home-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-plugin-non-admin-data-'));
  await fs.cp(path.join(installedDataDir, 'plugins'), path.join(dataDir, 'plugins'), { recursive: true });
  const {
    CODE_AGENT_E2E: _e2e,
    CODE_AGENT_ENABLE_DEV_API: _devApi,
    ...baseEnv
  } = process.env;
  const child = spawn(process.execPath, ['dist/web/webServer.cjs'], {
    cwd: repositoryRoot,
    env: {
      ...baseEnv,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      HOME: home,
      CODE_AGENT_HOME: home,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);
  return { child, baseUrl, logs: () => output };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await buildFreshPluginZips();
});

test.afterAll(async () => {
  if (mutationDir) await fs.rm(mutationDir, { recursive: true, force: true });
});

test('旧 renderer 契约真 zip 在 stage 被拒，宿主二次版本卡仍可见', async ({ page }) => {
  await waitForAppReady(page);

  const rejected = await invokeCommand<PackageResult<PackagePreview>>(
    page,
    'capability-package:stage-path',
    oldContractZipPath,
  );
  process.stdout.write(`OLD_CONTRACT_STAGE=${JSON.stringify(rejected)}\n`);
  expect(rejected.success).toBe(false);
  if (rejected.success) throw new Error('Old-contract plugin unexpectedly staged');
  expect(rejected.error).toContain('这个插件的界面版本与当前应用不匹配，请重新安装');

  // stage 已阻止旧包落盘；这里投影一个“升级后残留旧插件”的 list 响应，验证 renderer
  // 的二次版本门和用户卡片。正向生命周期仍全程使用刚刚真构建的 zip，不使用 LIVE fixture。
  const mismatchPackage: InstalledPackage = {
    id: builtManifest.id,
    name: builtManifest.name,
    version: builtManifest.version,
    description: builtManifest.description,
    permissions: builtManifest.permissions,
    state: 'active',
    toolNames: [],
    surface: 'internal-feature',
    internalFeature: {
      ...builtManifest.internalFeature,
      sdkVersion: { ...builtManifest.internalFeature.sdkVersion, renderer: 'pending' },
      loadedHash: 'old-contract-projection',
    },
  };
  await page.route('**/api/capability-package/list', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [mismatchPackage] }),
    });
  });
  await waitForAppReady(page);
  const accountButton = page.getByRole('button', { name: /用户菜单|User menu/u });
  await accountButton.click();
  await page.getByTestId('account-menu-internal-evaluation-center').click();
  const mismatchCard = page.getByRole('alert');
  await expect(mismatchCard).toContainText('这个插件的界面版本与当前应用不匹配。');
  await expect(mismatchCard.getByRole('button', { name: '去能力中心重新安装' })).toBeVisible();
  await page.unroute('**/api/capability-package/list');
});

test('真插件装、出项、打开、卸载，并复验 HTTP 安全边界', async ({ page }) => {
  await waitForAppReady(page);

  const staged = await invokeCommand<PackageResult<PackagePreview>>(
    page,
    'capability-package:stage-path',
    currentZipPath,
  );
  process.stdout.write(`CURRENT_STAGE=${JSON.stringify(staged)}\n`);
  expect(staged.success).toBe(true);
  if (!staged.success) throw new Error(staged.error);
  expect(staged.data.surface).toBe('internal-feature');
  expect(staged.data.sandbox.passed).toBe(true);

  const confirmed = await invokeCommand<PackageResult<{ id: string; surface: string }>>(
    page,
    'capability-package:confirm',
    staged.data.token,
  );
  process.stdout.write(`CURRENT_CONFIRM=${JSON.stringify(confirmed)}\n`);
  expect(confirmed).toMatchObject({ success: true, data: { id: 'evaluation-center', surface: 'internal-feature' } });

  const installed = await invokeCommand<PackageResult<InstalledPackage[]>>(page, 'capability-package:list');
  expect(installed.success).toBe(true);
  if (!installed.success) throw new Error(installed.error);
  const evaluationCenter = installed.data.find((plugin) => plugin.id === 'evaluation-center');
  expect(evaluationCenter).toMatchObject({ state: 'active', surface: 'internal-feature' });
  expect(evaluationCenter?.internalFeature?.loadedHash).toMatch(/^[a-f0-9]{64}$/u);

  const entryUrl = `${new URL(page.url()).origin}/internal-features/evaluation-center/index.js?v=${evaluationCenter?.internalFeature?.loadedHash}`;
  const loadedResponse = await curlRaw(entryUrl);
  process.stdout.write(`ADMIN_LOADED_HTTP=${loadedResponse.statusLine}\n`);
  expect(loadedResponse.statusLine).toContain(' 200 ');

  const traversalResponse = await curlRaw(
    `${new URL(page.url()).origin}/internal-features/evaluation-center/%2e%2e%2f%2e%2e%2fplugin.json`,
  );
  process.stdout.write(`TRAVERSAL_HTTP=${traversalResponse.statusLine}\n`);
  expect(traversalResponse.statusLine).toContain(' 404 ');

  await page.getByTestId('sidebar-capability-hub').click();
  await page.getByTestId('capability-hub-tab-plugins').click();
  await expect(page.getByTestId('capability-package-evaluation-center')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('capability-package-evaluation-center')).toContainText('已启用，可在左下角菜单打开');

  const accountButton = page.getByRole('button', { name: /用户菜单|User menu/u });
  await accountButton.click();
  const promptManager = page.getByTestId('user-menu-open-prompt-manager');
  const menuEntry = page.getByTestId('account-menu-internal-evaluation-center');
  await expect(promptManager).toBeVisible();
  await expect(menuEntry).toBeVisible();
  const appearsAfterPromptManager = await promptManager.evaluate((promptNode, pluginNode) => (
    Boolean(promptNode.compareDocumentPosition(pluginNode as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ), await menuEntry.elementHandle());
  expect(appearsAfterPromptManager).toBe(true);
  await page.screenshot({ path: screenshots.menu, fullPage: true });

  await menuEntry.click();
  const evalPage = page.getByTestId('eval-center-page');
  await expect(evalPage).toBeVisible({ timeout: 30_000 });
  await expect(evalPage).toHaveAttribute('data-page-variant', 'inline');
  for (const tab of ['telemetry', 'replay', 'cases', 'scorers', 'experiments', 'benchmarks', 'validation']) {
    await expect(page.getByTestId(`eval-center-tab-${tab}`)).toBeVisible();
  }
  await expect(page.getByText('LIVE', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window as unknown as Record<string, { Page?: unknown }>).__neoInternalFeature_evaluation_center?.Page)).toBe('function');
  const layout = await evalPage.evaluate((node) => {
    const pageRect = (node as HTMLElement).getBoundingClientRect();
    const sidebarZone = document.querySelector('[data-testid="sidebar-capability-zone"]');
    const sidebar = sidebarZone?.closest('.w-60');
    return {
      pageWidth: pageRect.width,
      sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.pageWidth).toBeGreaterThanOrEqual(layout.viewportWidth - layout.sidebarWidth - 2);

  // 2026-09-04（N-EVAL-UX-SCROLL）：宿主 HostSurface 若不是 flex 容器，插件页根节点的
  // flex-1 + min-h-0 全部失效 —— 页高退化成内容高度（题库 165 行把它撑到 10490px），
  // 页内每一个 overflow-y-auto 面板都永远滚不动。真机逮到的病，断言落在「页高被宿主那格框住
  // 且长列表真能滚」上；去掉 HostSurface 的 flex flex-col 这两条必红。
  await page.getByTestId('eval-center-tab-cases').click();
  await expect(page.getByTestId('eval-case-list-tab')).toBeVisible({ timeout: 20_000 });
  const scrollLayout = await evalPage.evaluate((node) => {
    const element = node as HTMLElement;
    const host = element.parentElement;
    const scroller = [...element.querySelectorAll('*')].find((candidate) => {
      const style = getComputedStyle(candidate);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll')
        && candidate.scrollHeight > candidate.clientHeight + 4;
    });
    return {
      pageHeight: element.clientHeight,
      hostHeight: host?.clientHeight ?? 0,
      scrollerOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    };
  });
  expect(scrollLayout.pageHeight).toBeLessThanOrEqual(scrollLayout.hostHeight);
  expect(scrollLayout.scrollerOverflow).toBeGreaterThan(0);

  await page.screenshot({ path: screenshots.rendered, fullPage: true });

  const e2eDataDir = process.env.CODE_AGENT_E2E_DATA_DIR;
  if (!e2eDataDir) throw new Error('Internal plugin E2E data dir was not propagated to the Playwright worker');
  const nonAdmin = await startNonAdminServer(e2eDataDir);
  try {
    const nonAdminResponse = await curlRaw(
      `${nonAdmin.baseUrl}/internal-features/evaluation-center/index.js?v=${evaluationCenter?.internalFeature?.loadedHash}`,
    );
    process.stdout.write(`NON_ADMIN_HTTP=${nonAdminResponse.statusLine}\n`);
    expect(nonAdminResponse.statusLine).toContain(' 404 ');
  } finally {
    process.stdout.write(`NON_ADMIN_SERVER_LOG_TAIL=${nonAdmin.logs().split('\n').slice(-8).join(' | ')}\n`);
    await stopServer(nonAdmin.child);
  }

  const uninstalled = await invokeCommand<PackageResult<null>>(
    page,
    'capability-package:uninstall',
    'evaluation-center',
  );
  process.stdout.write(`UNINSTALL=${JSON.stringify(uninstalled)}\n`);
  expect(uninstalled.success).toBe(true);

  // 保持 activeInternalFeatureId 到 refresh 执行：PluginsSettings 的生产 reload 会调用
  // internalFeatureStore.refresh()，由它负责关页和生成“插件已卸载”提示。
  await page.evaluate(() => {
    const appStoreModule = window.__NEO_INTERNAL_SDK__?.modules['@renderer/stores/appStore'] as {
      useAppStore?: { setState: (state: Record<string, unknown>) => void };
    } | undefined;
    appStoreModule?.useAppStore?.setState({ showCapabilityHub: true, capabilityHubTab: 'plugins' });
  });
  await expect(page.getByTestId('capability-hub-page')).toBeVisible();
  await expect(page.getByTestId('capability-package-evaluation-center')).toHaveCount(0, { timeout: 20_000 });
  const unloadToast = page.getByRole('alert').filter({ hasText: '评测中心插件已卸载' });
  await expect(unloadToast).toBeVisible();
  await page.evaluate(() => {
    const appStoreModule = window.__NEO_INTERNAL_SDK__?.modules['@renderer/stores/appStore'] as {
      useAppStore?: { setState: (state: Record<string, unknown>) => void };
    } | undefined;
    appStoreModule?.useAppStore?.setState({ showCapabilityHub: false });
  });
  await expect(evalPage).toHaveCount(0);
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 20_000 });
  await expect(unloadToast).toBeVisible();
  await page.screenshot({ path: screenshots.uninstalledPage, fullPage: true });

  const unloadedResponse = await curlRaw(entryUrl);
  process.stdout.write(`UNLOADED_HTTP=${unloadedResponse.statusLine}\n`);
  expect(unloadedResponse.statusLine).toContain(' 404 ');

  await accountButton.click();
  await expect(menuEntry).toHaveCount(0);
  await page.screenshot({ path: screenshots.uninstalledMenu, fullPage: true });

});

const realEvalTest = realEvalEnabled ? test : test.skip;

realEvalTest('真插件内完成选集、真跑、结果下钻与设基准', async ({ page }) => {
  test.setTimeout(420_000);
  await waitForAppReady(page);

  const staged = await invokeCommand<PackageResult<PackagePreview>>(
    page,
    'capability-package:stage-path',
    currentZipPath,
  );
  expect(staged.success).toBe(true);
  if (!staged.success) throw new Error(staged.error);
  expect(staged.data).toMatchObject({ surface: 'internal-feature', sandbox: { passed: true } });
  const confirmed = await invokeCommand<PackageResult<{ id: string; surface: string }>>(
    page,
    'capability-package:confirm',
    staged.data.token,
  );
  expect(confirmed).toMatchObject({
    success: true,
    data: { id: 'evaluation-center', surface: 'internal-feature' },
  });

  await page.getByTestId('sidebar-capability-hub').click();
  await page.getByTestId('capability-hub-tab-plugins').click();
  await expect(page.getByTestId('capability-package-evaluation-center')).toBeVisible({ timeout: 20_000 });

  const accountButton = page.getByRole('button', { name: /用户菜单|User menu/u });
  await accountButton.click();
  const menuEntry = page.getByTestId('account-menu-internal-evaluation-center');
  await expect(menuEntry).toBeVisible({ timeout: 30_000 });
  await menuEntry.click();
  await expect(page.getByTestId('eval-center-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('eval-center-tab-benchmarks').click();
  await expect(page.getByTestId('eval-benchmarks-tab')).toBeVisible();

  await page.getByRole('button', { name: '开跑', exact: true }).click();
  const selection = page.getByTestId('eval-case-selection-fields');
  await expect(selection).toBeVisible();
  const heldIn = selection.getByRole('button', { name: /日常集/u });
  const maxCases = selection.getByRole('spinbutton', { name: '最多跑 N 题' });
  await expect(heldIn.locator('span').last()).toHaveText(/^\d+$/u, { timeout: 30_000 });
  const heldInCount = (await heldIn.locator('span').last().textContent())?.trim();
  await heldIn.click();
  await expect(heldIn).toHaveClass(/ring-1/u);
  if (!heldInCount || !/^\d+$/u.test(heldInCount)) throw new Error('日常集题量不可读');
  await expect(maxCases).toHaveValue(heldInCount);
  await maxCases.fill('1');
  await expect(maxCases).toHaveValue('1');
  await page.screenshot({ path: realEvalScreenshots.selection, fullPage: true });

  const confirmRun = page.getByTestId('eval-run-confirm');
  const estimatedCost = page.getByText(/^约 \$\d/u).first();
  await expect(estimatedCost).toContainText('按价格表');
  await startCapturingEvalEvents(page);
  await confirmRun.click();
  await expect(confirmRun).toContainText('再点一次确认');
  await page.screenshot({ path: realEvalScreenshots.confirmation, fullPage: true });
  await confirmRun.click();

  const activeRun = page.getByTestId('eval-run-active');
  await expect(activeRun).toBeVisible({ timeout: 30_000 });
  await expect.poll(
    async () => (await readCapturedEvalEvents(page)).some((event) => event.type === 'run_start'),
    { timeout: 30_000, message: 'run_start must arrive through RUN_EVENTS' },
  ).toBe(true);
  const runStart = (await readCapturedEvalEvents(page)).find((event) => event.type === 'run_start');
  if (!runStart) throw new Error('RUN_EVENTS did not contain run_start');
  const runId = runStart.runId;
  expect(runStart.plannedCaseIds).toHaveLength(1);
  await expect.poll(
    async () => (await readCapturedEvalEvents(page)).some(
      (event) => event.runId === runId && event.type === 'case_start',
    ),
    { timeout: 60_000, message: 'progress must advance to a real case_start event' },
  ).toBe(true);
  await expect(activeRun).toContainText(/第 1\/1 题/u);
  await page.screenshot({ path: realEvalScreenshots.active, fullPage: true });

  await expect.poll(
    async () => (await readCapturedEvalEvents(page)).some(
      (event) => event.runId === runId && event.type === 'run_end',
    ),
    { timeout: 300_000, intervals: [250, 500, 1_000], message: 'real evaluation must emit run_end' },
  ).toBe(true);
  const events = await readCapturedEvalEvents(page);
  const runEnd = events.find((event) => event.runId === runId && event.type === 'run_end');
  if (!runEnd) throw new Error(`RUN_EVENTS did not contain run_end for ${runId}`);
  expect(runEnd.summary?.completed).toBe(true);
  expect(runEnd.summary?.passed).toEqual(expect.any(Number));
  expect(runEnd.summary?.failed).toEqual(expect.any(Number));

  await expect(activeRun).toHaveCount(0, { timeout: 30_000 });
  const resultRow = page.getByTestId(`benchmark-run-${runId}`);
  await expect(resultRow).toBeVisible({ timeout: 30_000 });
  await expect(resultRow).toContainText('通过率');
  await expect(resultRow).toContainText('完成');
  await page.screenshot({ path: realEvalScreenshots.result, fullPage: true });

  const caseEnds = events.filter((event) => event.runId === runId && event.type === 'case_end');
  expect(caseEnds).toHaveLength(1);
  const caseEnd = caseEnds[0];
  expect(caseEnd.usageStatus).toBe('available');
  expect(caseEnd.costUsd).toBeGreaterThan(0);
  process.stdout.write(`REAL_EVAL_CASE_END=${JSON.stringify(caseEnd)}\n`);
  process.stdout.write(`REAL_EVAL_RUN=${JSON.stringify({ runId, costUsd: caseEnd.costUsd })}\n`);

  const experiments = await invokeCommand<Array<{ id: string }>>(
    page,
    'evaluation:list-experiments',
    { limit: 100, source: 'eval' },
  );
  expect(experiments.some((experiment) => experiment.id === runId)).toBe(true);
  const caseId = caseEnd.testId ?? runStart.plannedCaseIds?.[0];
  if (!caseId) throw new Error(`No caseId was persisted for ${runId}`);
  const persistedCase = await invokeCommand<unknown>(
    page,
    'evaluation:load-case',
    { experimentId: runId, caseId },
  );
  expect(persistedCase).toBeTruthy();
  await page.screenshot({ path: realEvalScreenshots.usage, fullPage: true });

  await page.getByTestId(`benchmark-run-expand-${runId}`).click();
  const caseRow = page.getByTestId(`benchmark-run-case-${runId}-${caseId}`);
  await expect(caseRow).toBeVisible();
  await caseRow.getByRole('button').click();
  const drawer = page.getByTestId('eval-case-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('eval-case-conclusion')).toHaveText(/\S/u);
  await page.screenshot({ path: realEvalScreenshots.drawer, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  const split = runStart.config?.split ?? 'held-in';
  const k = runStart.config?.k ?? 1;
  const baselineFile = path.join(repositoryRoot, '.claude', `eval-baseline.${split}.k${k}.json`);
  let priorBaseline: Buffer | undefined;
  try {
    priorBaseline = await fs.readFile(baselineFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await resultRow.getByRole('button', { name: '设为对比基准' }).click();
    const confirmBaseline = resultRow.getByRole('button', { name: '再点一次确认' });
    await expect(confirmBaseline).toBeVisible();
    await confirmBaseline.click();
    await expect.poll(async () => {
      const info = await invokeCommand<{ groups: Record<string, { experimentId?: string }> }>(
        page,
        'evaluation:baseline-info',
      );
      return Object.values(info.groups).some((group) => group.experimentId === runId);
    }, { timeout: 30_000, message: 'BASELINE_INFO must return the real runId' }).toBe(true);
    const baselineInfo = await invokeCommand<{ groups: Record<string, { experimentId?: string }> }>(
      page,
      'evaluation:baseline-info',
    );
    process.stdout.write(`REAL_EVAL_BASELINE_INFO=${JSON.stringify(baselineInfo)}\n`);
    expect(Object.values(baselineInfo.groups).some((group) => group.experimentId === runId)).toBe(true);
    await expect(resultRow).toContainText('当前对比基准');
    await page.screenshot({ path: realEvalScreenshots.baseline, fullPage: true });
  } finally {
    if (priorBaseline) {
      await fs.writeFile(baselineFile, priorBaseline);
    } else {
      await fs.rm(baselineFile, { force: true });
    }
    await stopCapturingEvalEvents(page);
  }
});
