// 产物冒烟共用的 headless 页面启动脚手架（从 gameArtifactRuntimeSmoke.ts 平移，
// 供 runRuntimeSmoke 与 runLightPlayabilitySmoke 复用；行为与原内联版本等价）。
import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { GAME_VALIDATION_TIMEOUTS } from '../../../../shared/constants/game';
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
 * Playwright 包不可用或浏览器启动全链失败 → { ok:false }（调用方按 skipped 处理，
 * 启动失败属于环境问题，不允许算成产物的 not_runnable——N-TEST-GAMESMOKE-FLAKY：
 * CI runner 无 bundled Chromium，冷启动饥饿下 CDP 超时后回退腿必失败，旧版把该
 * 启动异常抛给 smoke 的 catch，让 known-good 产物被误判 not_runnable）。
 * 启动阶段使用自有预算 ARTIFACT_PAGE_LAUNCH_MS，不占用调用方的 smoke deadline。
 */
export async function openArtifactPage(): Promise<OpenArtifactPageResult> {
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

  const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    // 降级留痕：每条启动腿失败都记下「哪条腿、为什么」，终止时并入 skippedReason。
    const launchFailures: string[] = [];

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
            mockKeychain: true,
          }),
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      await waitForCdpEndpoint(port, chromeProcess, GAME_VALIDATION_TIMEOUTS.ARTIFACT_PAGE_LAUNCH_MS);
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
      } catch (error) {
        launchFailures.push(`system Chrome CDP: ${describeError(error)}`);
        await cleanupSystemChromeAttempt();
      }
    }

    if (!page) {
      try {
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      } catch (error) {
        launchFailures.push(`Playwright bundled Chromium: ${describeError(error)}`);
        await browser?.close().catch(() => undefined);
        browser = null;
        if (resolution.provider === 'playwright-bundled') {
          const fallbackResolution = resolveBrowserProvider({ requestedProvider: 'system-chrome-cdp' });
          try {
            await launchSystemChromePage(fallbackResolution);
            launchChecks.push('runtime smoke fell back to system Chrome CDP because Playwright bundled Chromium is unavailable');
          } catch (fallbackError) {
            launchFailures.push(`system Chrome CDP fallback: ${describeError(fallbackError)}`);
            await cleanupSystemChromeAttempt();
          }
        } else {
          // provider 本就是 system-chrome-cdp：首次 CDP 失败多为冷启动饥饿贴线超时，
          // 此刻 chrome 二进制/页缓存已热，重试一次的成功率远高于直接放弃。
          try {
            await launchSystemChromePage(resolution);
            launchChecks.push('runtime smoke recovered on a system Chrome CDP retry after the first launch attempt failed');
          } catch (retryError) {
            launchFailures.push(`system Chrome CDP retry: ${describeError(retryError)}`);
            await cleanupSystemChromeAttempt();
          }
        }
        if (!page) {
          // 没有 session 交给调用方，必须在这里释放启动槽/清掉残留进程，否则
          // 信号量被漏占，后续所有浏览器冒烟会在 acquireLaunchSlot 上挂死。
          await close();
          return {
            ok: false,
            skippedReason: `browser launch failed (${launchFailures.join('; ')})`,
          };
        }
      }
    }

    return { ok: true, session: { page, launchChecks, close } };
  } catch (error) {
    await close();
    throw error;
  }
}
