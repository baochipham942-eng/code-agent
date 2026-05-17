import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import type { Page } from 'playwright';
import {
  finishWithError,
  getNumberOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  closeSystemChromeSession,
  formatAcceptanceError,
  getFreePort,
  launchSystemChromeSession,
} from './browser-computer-system-chrome.ts';

type PanelCheck = {
  key: string;
  menuLabel: string;
  closeLabel: string;
  expectedText: string[];
  testId?: string;
  advanced?: boolean;
  optional?: boolean;
};

const PANEL_CHECKS: PanelCheck[] = [
  {
    key: 'activity',
    menuLabel: 'Activity',
    closeLabel: '关闭 Activity',
    expectedText: ['Activity', 'ActivityContext 当前预览', 'Provider 状态'],
    testId: 'activity-panel',
  },
  {
    key: 'knowledgeMemory',
    menuLabel: '知识与记忆',
    closeLabel: '关闭 Knowledge / Memory',
    expectedText: ['Knowledge / Memory', 'Knowledge Inbox', 'Memory Audit', 'Light Memory'],
    testId: 'knowledge-memory-panel',
  },
  {
    key: 'evalCenter',
    menuLabel: '评测中心',
    closeLabel: '关闭 评测中心',
    expectedText: ['评测中心', '会话评测', 'Review Queue'],
    testId: 'eval-center-panel',
  },
  {
    key: 'cronCenter',
    menuLabel: '自动化',
    closeLabel: '关闭 Cron Center',
    expectedText: ['Cron Center', '定时任务调度'],
    testId: 'cron-center-panel',
  },
  {
    key: 'promptManager',
    menuLabel: '提示词',
    closeLabel: '关闭 提示词',
    expectedText: ['提示词', '默认提示词'],
    testId: 'prompt-manager-panel',
  },
  {
    key: 'settings',
    menuLabel: '设置',
    closeLabel: 'Close settings',
    expectedText: ['权限与安全', '工作区'],
    testId: 'settings-panel',
  },
  {
    key: 'lab',
    menuLabel: '实验室',
    closeLabel: '关闭 实验室',
    expectedText: ['实验室', 'AI 学习实验室'],
    testId: 'lab-page',
    advanced: true,
  },
  {
    key: 'computerUse',
    menuLabel: 'Computer Use',
    closeLabel: '关闭 Computer Use',
    expectedText: ['Computer Use', 'Activity Collector', 'AX Tree', '能力边界'],
    testId: 'computer-use-panel',
    advanced: true,
  },
  {
    key: 'timeCapability',
    menuLabel: 'Time & Capability',
    closeLabel: '关闭 Time & Capability',
    expectedText: ['Time & Capability', 'Time Workbench', 'Calendar connector', 'Capability Fix'],
    testId: 'time-capability-panel',
    advanced: true,
  },
  {
    key: 'workflow',
    menuLabel: 'Agent 流程',
    closeLabel: '关闭 Workflow',
    expectedText: ['Workflow'],
    testId: 'workflow-panel',
    advanced: true,
    optional: true,
  },
  {
    key: 'browserSurface',
    menuLabel: '浏览器',
    closeLabel: '关闭 Browser Surface',
    expectedText: ['Browser Surface', '托管浏览器'],
    testId: 'browser-surface-panel',
    advanced: true,
  },
  {
    key: 'desktopCollector',
    menuLabel: '桌面采集',
    closeLabel: '关闭 桌面采集',
    expectedText: ['桌面活动', '采集'],
    testId: 'desktop-status-panel',
    advanced: true,
  },
  {
    key: 'inAppValidation',
    menuLabel: 'In-App 验证',
    closeLabel: '关闭 In-App 验证',
    expectedText: ['In-App 验证', '载入 Demo'],
    testId: 'in-app-validation-panel',
    advanced: true,
  },
];

function usage(): void {
  console.log(`Workbench menu panels smoke

Usage:
  npm run acceptance:workbench-menu-panels -- [options]

Options:
  --visible       Launch system Chrome in visible mode.
  --skip-build    Reuse existing dist/web and dist/renderer artifacts.
  --keep-browser  Keep the Chrome process open after the smoke.
  --keep-server   Keep the app-host server process open after the smoke.
  --port <port>   App-host port. Default: auto.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - the local app-host serves the current renderer build
  - the lower-left user menu exposes common and advanced secondary pages
  - each menu entry opens its panel, renders key content, uses a fullscreen shell, and can close back to chat`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code ?? 1}`));
      }
    });
  });
}

async function ensureBuild(skipBuild: boolean): Promise<void> {
  if (skipBuild) {
    if (!existsSync('dist/web/webServer.cjs')) {
      throw new Error('dist/web/webServer.cjs is missing. Run without --skip-build first.');
    }
    if (!existsSync('dist/renderer/index.html')) {
      throw new Error('dist/renderer/index.html is missing. Run without --skip-build first.');
    }
    return;
  }

  await runCommand(npmCommand(), ['run', 'build:web'], 'build:web');
  await runCommand(npmCommand(), ['run', 'build:renderer'], 'build:renderer');
}

function startAppHost(port: number): { child: ChildProcessWithoutNullStreams; output: () => string } {
  let logs = '';
  const child = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      CODE_AGENT_ENABLE_DEV_API: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (chunk: Buffer) => {
    logs += chunk.toString();
    if (logs.length > 20_000) {
      logs = logs.slice(-20_000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  return { child, output: () => logs };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 2_000);

    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

async function waitForHealth(baseUrl: string, server: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (server.exitCode !== null) {
      throw new Error(`app-host exited early with code ${server.exitCode}\n${output()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for app-host health at ${baseUrl}/api/health\n${output()}`);
}

async function waitForAppReady(page: Page, timeoutMs = 60_000): Promise<void> {
  try {
    await page.setViewportSize({ width: 1440, height: 960 }).catch(() => undefined);
    const userMenu = page.getByLabel('用户菜单');
    if (!await userMenu.isVisible().catch(() => false)) {
      const showSidebar = page.getByLabel('Show sidebar');
      if (await showSidebar.isVisible().catch(() => false)) {
        await showSidebar.click({ timeout: 5_000 });
      }
    }
    await userMenu.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('[data-chat-input]').waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const bodyText = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`App UI did not render the authenticated chat shell within ${timeoutMs}ms.
URL: ${page.url()}
Body:
${bodyText.slice(0, 1_500)}

Original error:
${message}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactButton(page: Page, label: string) {
  return page.locator('button').filter({ hasText: new RegExp(`^${escapeRegExp(label)}`) }).first();
}

async function ensureUserMenuOpen(page: Page): Promise<void> {
  const activityEntry = exactButton(page, 'Activity');
  if (await activityEntry.isVisible().catch(() => false)) return;

  await page.getByLabel('用户菜单').click({ timeout: 5_000 });
  await activityEntry.waitFor({ state: 'visible', timeout: 5_000 });
}

async function ensureAdvancedToolsOpen(page: Page): Promise<void> {
  await ensureUserMenuOpen(page);
  if (await exactButton(page, 'Computer Use').isVisible().catch(() => false)) return;

  await exactButton(page, '高级工具').click({ timeout: 5_000 });
  await exactButton(page, 'Computer Use').waitFor({ state: 'visible', timeout: 5_000 });
}

async function validateMenuEntries(page: Page, failures: string[]): Promise<Record<string, boolean>> {
  await ensureUserMenuOpen(page);
  const result: Record<string, boolean> = {};

  for (const panel of PANEL_CHECKS) {
    if (panel.advanced) {
      await ensureAdvancedToolsOpen(page);
    }
    const visible = await exactButton(page, panel.menuLabel).isVisible().catch(() => false);
    result[panel.key] = visible;
    if (!visible) {
      if (!panel.optional) {
        failures.push(`lower-left menu missing "${panel.menuLabel}"`);
      }
    }
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  return result;
}

async function openPanel(page: Page, panel: PanelCheck): Promise<void> {
  await ensureUserMenuOpen(page);
  if (panel.advanced) {
    await ensureAdvancedToolsOpen(page);
  }
  await exactButton(page, panel.menuLabel).click({ timeout: 5_000 });
  await page.getByLabel(panel.closeLabel).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function closePanel(page: Page, panel: PanelCheck): Promise<void> {
  await page.getByLabel(panel.closeLabel).click({ timeout: 5_000 });
  await page.getByLabel(panel.closeLabel).waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

async function waitForPanelBodyText(page: Page, panel: PanelCheck, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let bodyText = '';
  while (Date.now() < deadline) {
    bodyText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    if (panel.expectedText.every((expected) => bodyText.includes(expected))) {
      return bodyText;
    }
    await page.waitForTimeout(250);
  }
  return bodyText;
}

async function validatePanel(page: Page, panel: PanelCheck): Promise<{
  key: string;
  menuLabel: string;
  ok: boolean;
  missingText: string[];
  layoutOk: boolean;
  layoutFailure?: string;
}> {
  await openPanel(page, panel);

  const bodyText = await waitForPanelBodyText(page, panel);
  const missingText = panel.expectedText.filter((expected) => !bodyText.includes(expected));
  let layoutOk = true;
  let layoutFailure: string | undefined;

  if (panel.testId) {
    const target = page.getByTestId(panel.testId);
    const box = await target.boundingBox().catch(() => null);
    const viewport = page.viewportSize();
    if (!box || !viewport) {
      layoutOk = false;
      layoutFailure = `${panel.testId} did not expose a measurable fullscreen container`;
    } else {
      const xOk = Math.abs(box.x) <= 1;
      const yOk = Math.abs(box.y) <= 1;
      const widthOk = box.width >= viewport.width - 2;
      const heightOk = box.height >= viewport.height - 2;
      layoutOk = xOk && yOk && widthOk && heightOk;
      if (!layoutOk) {
        layoutFailure = `${panel.testId} bbox ${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)} did not cover viewport ${viewport.width}x${viewport.height}`;
      }
    }
  }

  await closePanel(page, panel);

  return {
    key: panel.key,
    menuLabel: panel.menuLabel,
    ok: missingText.length === 0 && layoutOk,
    missingText,
    layoutOk,
    layoutFailure,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  await ensureBuild(hasFlag(args, 'skip-build'));

  const appPort = getNumberOption(args, 'port') || await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const appHost = startAppHost(appPort);
  let chromeSession: Awaited<ReturnType<typeof launchSystemChromeSession>> | null = null;
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    await waitForHealth(baseUrl, appHost.child, appHost.output);

    chromeSession = await launchSystemChromeSession({
      profilePrefix: 'code-agent-workbench-menu-panels-',
      visible: hasFlag(args, 'visible'),
      initialUrl: baseUrl,
    });

    const context = chromeSession.browser.contexts()[0] || await chromeSession.browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location();
        const suffix = location.url ? ` @ ${location.url}` : '';
        consoleErrors.push(`${message.text()}${suffix}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        consoleErrors.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);

    const menu = await validateMenuEntries(page, failures);
    const panels = [];
    for (const panel of PANEL_CHECKS) {
      if (panel.optional && menu[panel.key] === false) {
        panels.push({
          key: panel.key,
          menuLabel: panel.menuLabel,
          ok: true,
          skipped: true,
          missingText: [],
          layoutOk: true,
        });
        continue;
      }
      const result = await validatePanel(page, panel);
      panels.push(result);
      if (result.missingText.length > 0) {
        failures.push(`${panel.menuLabel} panel missing text: ${result.missingText.join(', ')}`);
      }
      if (!result.layoutOk && result.layoutFailure) {
        failures.push(`${panel.menuLabel} panel layout: ${result.layoutFailure}`);
      }
    }

    const backToChat = await page.locator('[data-chat-input]').isVisible().catch(() => false)
      && await page.getByLabel('用户菜单').isVisible().catch(() => false);
    if (!backToChat) {
      failures.push('chat shell was not visible after closing all panels');
    }

    if (consoleErrors.length > 0) {
      failures.push(`browser console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
    if (pageErrors.length > 0) {
      failures.push(`browser page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    }

    const result = {
      ok: failures.length === 0,
      appHost: {
        baseUrl,
        serverRunning: appHost.child.exitCode === null,
      },
      chrome: chromeSession ? {
        provider: chromeSession.provider,
        executable: chromeSession.executable,
        cdpPort: chromeSession.port,
        mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
      } : null,
      menu,
      panels,
      backToChat,
      consoleErrors,
      pageErrors,
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Workbench Menu Panels Smoke Summary', [
        ['baseUrl', result.appHost.baseUrl],
        ['chromeProvider', result.chrome?.provider],
        ['chromeExecutable', result.chrome?.executable],
        ['chromeMode', result.chrome?.mode],
        ['menuActivity', result.menu.activity],
        ['menuKnowledgeMemory', result.menu.knowledgeMemory],
        ['menuEvalCenter', result.menu.evalCenter],
        ['menuCronCenter', result.menu.cronCenter],
        ['menuPromptManager', result.menu.promptManager],
        ['menuSettings', result.menu.settings],
        ['menuLab', result.menu.lab],
        ['menuComputerUse', result.menu.computerUse],
        ['menuTimeCapability', result.menu.timeCapability],
        ['panelsPassed', panels.filter((panel) => panel.ok).length],
        ['panelCount', panels.length],
        ['backToChat', result.backToChat],
        ['consoleErrors', consoleErrors.length],
        ['pageErrors', pageErrors.length],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nWorkbench menu panels smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!hasFlag(args, 'keep-browser')) {
      await chromeSession?.browser.close().catch(() => undefined);
      if (chromeSession) {
        await closeSystemChromeSession(chromeSession).catch(() => undefined);
      }
    }
    if (!hasFlag(args, 'keep-server')) {
      await stopProcess(appHost.child);
    }
  }
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
