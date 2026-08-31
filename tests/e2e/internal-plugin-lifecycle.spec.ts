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

async function buildFreshPluginZips(): Promise<void> {
  await fs.mkdir(evidenceAssetsDir, { recursive: true });
  const manifestPath = path.join(packageRoot, 'plugin.json');
  const originalManifest = await fs.readFile(manifestPath, 'utf8');
  try {
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
  } finally {
    await fs.writeFile(manifestPath, originalManifest, 'utf8');
  }
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

  // TODO(N-EVAL-USAGE-COMPAT): 扩成真评测流程：选集 → 真跑 → 进行中 → 结果 → 抽屉 → 设基准。
});
