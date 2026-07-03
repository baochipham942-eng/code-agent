// 产物冒烟共用的 headless 页面启动脚手架（从 gameArtifactRuntimeSmoke.ts 平移，
// 供 runRuntimeSmoke 与 runLightPlayabilitySmoke 复用；行为与原内联版本等价）。
import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveBrowserProvider,
  resolveCdpEndpointUrl,
} from '../../../services/infra/browserProvider';
import { acquireLaunchSlot, type LaunchSlot } from '../../../services/infra/playwrightLaunchSemaphore';
import { waitForCdpEndpoint, stopChromeProcess } from './chromeProcess';
import { loadPlaywrightChromium } from './playwrightRuntime';

export interface ArtifactPageSession {
  page: import('playwright').Page;
  launchChecks: string[];
  close(): Promise<void>;
}

export type OpenArtifactPageResult =
  | { ok: true; session: ArtifactPageSession }
  | { ok: false; skippedReason: string };

/**
 * 打开一个用于产物冒烟的 headless 页面（system-chrome-cdp 优先，回退 bundled Chromium）。
 * 调用方负责 finally 调 session.close()。
 * Playwright 包不可用 → { ok:false }（调用方按 skipped 处理）；浏览器启动失败 → 抛错。
 */
export async function openArtifactPage(timeoutMs: number): Promise<OpenArtifactPageResult> {
  let browser: import('playwright').Browser | null = null;
  let chromeProcess: ChildProcess | null = null;
  let profileDir: string | null = null;
  let launchSlot: LaunchSlot | null = null;

  const close = async () => {
    await (browser as import('playwright').Browser | null)?.close().catch(() => undefined);
    await stopChromeProcess(chromeProcess).catch(() => undefined);
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
    launchSlot?.release();
  };

  try {
    const playwright = await loadPlaywrightChromium();
    if (!playwright.ok || !playwright.chromium) {
      return { ok: false, skippedReason: playwright.error || 'Playwright package unavailable.' };
    }
    launchSlot = await acquireLaunchSlot();
    const { chromium } = playwright;
    const resolution = resolveBrowserProvider();
    let page: import('playwright').Page | null = null;
    const launchChecks: string[] = [];

    const cleanupSystemChromeAttempt = async () => {
      await browser?.close().catch(() => undefined);
      browser = null;
      await stopChromeProcess(chromeProcess).catch(() => undefined);
      chromeProcess = null;
      if (profileDir) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        profileDir = null;
      }
    };

    const launchSystemChromePage = async (launchResolution: typeof resolution) => {
      if (launchResolution.missingExecutable || !launchResolution.systemExecutable) {
        throw new Error(launchResolution.recommendedAction || 'System Chrome executable is missing.');
      }
      const port = await findAvailablePort();
      profileDir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-runtime-'));
      chromeProcess = spawn(
        launchResolution.systemExecutable,
        [
          ...buildSystemChromeCdpArgs({
            cdpPort: port,
            profileDir,
            headless: true,
            viewport: { width: 900, height: 700 },
          }),
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      await waitForCdpEndpoint(port, chromeProcess, Math.min(timeoutMs, 8000));
      browser = await chromium.connectOverCDP(await resolveCdpEndpointUrl(port));
      const context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: 900, height: 700 },
      });
      page = context.pages()[0] || await context.newPage();
      await page.setViewportSize({ width: 900, height: 700 });
    };

    if (resolution.provider === 'system-chrome-cdp' && !resolution.missingExecutable && resolution.systemExecutable) {
      try {
        await launchSystemChromePage(resolution);
      } catch {
        await cleanupSystemChromeAttempt();
      }
    }

    if (!page) {
      try {
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      } catch (error) {
        await browser?.close().catch(() => undefined);
        browser = null;
        if (resolution.provider === 'playwright-bundled') {
          const fallbackResolution = resolveBrowserProvider({ requestedProvider: 'system-chrome-cdp' });
          try {
            await launchSystemChromePage(fallbackResolution);
            launchChecks.push('runtime smoke fell back to system Chrome CDP because Playwright bundled Chromium is unavailable');
          } catch {
            await cleanupSystemChromeAttempt();
          }
        }
        if (!page) throw error;
      }
    }

    return { ok: true, session: { page, launchChecks, close } };
  } catch (error) {
    await close();
    throw error;
  }
}
