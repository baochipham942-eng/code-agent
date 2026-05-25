import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  buildSystemChromeCdpArgs,
  findAvailablePort,
  resolveBrowserProvider,
  resolveCdpEndpointUrl,
} from '../../../services/infra/browserProvider';
import type {
  BrowserVisualSmokeSummary,
  BrowserVisualSmokeDiagnostics,
  BrowserVisualSmokeOptions,
  BrowserInteractionStep,
  BrowserInteractionStepResult,
} from './types';
import { waitForCdpEndpoint, stopChromeProcess } from './chromeProcess';
import { loadPlaywrightChromium } from './playwrightRuntime';
import { runComputerUseVisualFallback } from './computerUseVisualFallback';
import { acquireLaunchSlot, type LaunchSlot } from '../../../services/infra/playwrightLaunchSemaphore';

export const DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS = 10000;
const DEFAULT_BROWSER_INTERACTION_EXPECT_TIMEOUT_MS = 5000;
const INTERACTION_POST_ACTION_SETTLE_MS = 200;

const BROWSER_VISUAL_SMOKE_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'wide-desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 390, height: 780 },
] as const;

type BrowserViewportName = (typeof BROWSER_VISUAL_SMOKE_VIEWPORTS)[number]['name'];

interface CanvasLayoutMetrics {
  width: number;
  height: number;
  visibleRatio: number;
  internalWidth?: number;
  internalHeight?: number;
}

function normalizeVisualSmokeOptions(
  optionsOrTimeout: number | BrowserVisualSmokeOptions | undefined,
): { timeoutMs: number; interactions: BrowserInteractionStep[] } {
  if (typeof optionsOrTimeout === 'number') {
    return { timeoutMs: optionsOrTimeout, interactions: [] };
  }
  if (!optionsOrTimeout) {
    return { timeoutMs: DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS, interactions: [] };
  }
  return {
    timeoutMs: optionsOrTimeout.timeoutMs ?? DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS,
    interactions: optionsOrTimeout.interactions ?? [],
  };
}

function stepAppliesToViewport(step: BrowserInteractionStep, viewport: BrowserViewportName): boolean {
  const target = step.viewport ?? 'both';
  const viewportFamily = viewport === 'wide-desktop' ? 'desktop' : viewport;
  return target === 'both' || target === viewportFamily;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCanvasFrames(
  canvases: Array<{
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    visibleRatio: number;
    internalWidth: number;
    internalHeight: number;
  }>,
): string {
  return canvases
    .slice(0, 2)
    .map((canvas) =>
      `${roundMetric(canvas.width)}x${roundMetric(canvas.height)} at left=${roundMetric(canvas.left)}, right=${roundMetric(canvas.right)}, visibleRatio=${roundMetric(canvas.visibleRatio)}, internal=${canvas.internalWidth}x${canvas.internalHeight}`
    )
    .join('; ') || 'none';
}

function mobileCanvasRepairHint(viewportWidth: number): string {
  return `Repair hint: constrain the canvas or wrapper to the viewport on both axes, e.g. max-width: calc(100vw - 16px), max-height: calc(100dvh - 16px), aspect-ratio, height:auto. The full playfield must fit a ${viewportWidth}px mobile viewport; fixed canvas width or max-height-only scaling can still overflow.`;
}

function wideCanvasRepairHint(): string {
  return 'Repair hint: keep internal drawing resolution if needed, but let the game shell/canvas scale up on wide desktop previews with viewport-relative width and height. Avoid a fixed 800px/900px max-width that leaves the game small in a large black preview.';
}

export function isPrimaryGameCanvasUndersizedForViewport(
  canvases: CanvasLayoutMetrics[],
  viewport: { width: number; height: number },
): boolean {
  if (viewport.width < 1440 || viewport.height < 800 || canvases.length === 0) return false;
  const primaryCanvas = canvases
    .filter((canvas) => canvas.width >= 16 && canvas.height >= 16 && canvas.visibleRatio >= 0.82)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!primaryCanvas) return false;

  const widthRatio = primaryCanvas.width / viewport.width;
  const heightRatio = primaryCanvas.height / viewport.height;
  return widthRatio < 0.5 && heightRatio < 0.65;
}

export function hasGameCanvasAspectRatioMismatch(canvases: CanvasLayoutMetrics[]): boolean {
  return canvases.some((canvas) => {
    if (
      canvas.width < 16
      || canvas.height < 16
      || canvas.visibleRatio < 0.82
      || !canvas.internalWidth
      || !canvas.internalHeight
      || canvas.internalWidth < 16
      || canvas.internalHeight < 16
    ) {
      return false;
    }
    const renderedAspect = canvas.width / canvas.height;
    const internalAspect = canvas.internalWidth / canvas.internalHeight;
    const driftRatio = Math.abs(renderedAspect - internalAspect) / internalAspect;
    return driftRatio > 0.12;
  });
}

export function cloneBrowserVisualSmoke(summary: BrowserVisualSmokeSummary): BrowserVisualSmokeSummary {
  return {
    attempted: summary.attempted,
    skipped: summary.skipped,
    passed: summary.passed,
    failures: [...summary.failures],
    checks: [...summary.checks],
    diagnostics: summary.diagnostics
      ? {
          ...summary.diagnostics,
          consoleErrors: summary.diagnostics.consoleErrors ? [...summary.diagnostics.consoleErrors] : undefined,
          pageErrors: summary.diagnostics.pageErrors ? [...summary.diagnostics.pageErrors] : undefined,
          computerUseFallback: summary.diagnostics.computerUseFallback
            ? { ...summary.diagnostics.computerUseFallback }
            : undefined,
          viewports: summary.diagnostics.viewports
            ? summary.diagnostics.viewports.map((viewport) => ({ ...viewport }))
            : undefined,
          interactions: summary.diagnostics.interactions
            ? summary.diagnostics.interactions.map((step) => ({
                ...step,
                action: { ...step.action } as BrowserInteractionStepResult['action'],
                failures: [...step.failures],
                checks: [...step.checks],
              }))
            : undefined,
        }
      : undefined,
  };
}

async function runInteractionStep(
  page: import('playwright').Page,
  step: BrowserInteractionStep,
  viewport: BrowserViewportName,
): Promise<BrowserInteractionStepResult> {
  const startedAt = Date.now();
  const failures: string[] = [];
  const checks: string[] = [];
  const expectTimeout = step.expect?.timeoutMs ?? DEFAULT_BROWSER_INTERACTION_EXPECT_TIMEOUT_MS;
  const labelPrefix = `[${viewport}${step.label ? ` · ${step.label}` : ''}]`;

  try {
    switch (step.action.type) {
      case 'click':
        await page.mouse.click(step.action.x, step.action.y);
        checks.push(`${labelPrefix} clicked at (${step.action.x}, ${step.action.y})`);
        break;
      case 'click-selector':
        await page.locator(step.action.selector).first().click({ timeout: expectTimeout });
        checks.push(`${labelPrefix} clicked selector ${step.action.selector}`);
        break;
      case 'hover':
        await page.mouse.move(step.action.x, step.action.y);
        checks.push(`${labelPrefix} hovered at (${step.action.x}, ${step.action.y})`);
        break;
      case 'type':
        await page.keyboard.type(step.action.text);
        checks.push(`${labelPrefix} typed ${step.action.text.length} char(s)`);
        break;
      case 'press':
        await page.keyboard.press(step.action.key);
        checks.push(`${labelPrefix} pressed ${step.action.key}`);
        break;
      case 'wait':
        await page.waitForTimeout(step.action.ms);
        checks.push(`${labelPrefix} waited ${step.action.ms}ms`);
        break;
    }

    await page.waitForTimeout(INTERACTION_POST_ACTION_SETTLE_MS);

    if (step.expect) {
      if (step.expect.textVisible) {
        try {
          await page.getByText(step.expect.textVisible, { exact: false }).first().waitFor({
            state: 'visible',
            timeout: expectTimeout,
          });
          checks.push(`${labelPrefix} text visible: ${step.expect.textVisible}`);
        } catch (error) {
          failures.push(
            `${labelPrefix} expected text "${step.expect.textVisible}" not visible within ${expectTimeout}ms (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (step.expect.textHidden) {
        try {
          await page.getByText(step.expect.textHidden, { exact: false }).first().waitFor({
            state: 'hidden',
            timeout: expectTimeout,
          });
          checks.push(`${labelPrefix} text hidden: ${step.expect.textHidden}`);
        } catch (error) {
          failures.push(
            `${labelPrefix} expected text "${step.expect.textHidden}" not hidden within ${expectTimeout}ms (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (step.expect.selectorVisible) {
        try {
          await page.locator(step.expect.selectorVisible).first().waitFor({
            state: 'visible',
            timeout: expectTimeout,
          });
          checks.push(`${labelPrefix} selector visible: ${step.expect.selectorVisible}`);
        } catch (error) {
          failures.push(
            `${labelPrefix} expected selector "${step.expect.selectorVisible}" not visible within ${expectTimeout}ms (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (step.expect.selectorHidden) {
        try {
          await page.locator(step.expect.selectorHidden).first().waitFor({
            state: 'hidden',
            timeout: expectTimeout,
          });
          checks.push(`${labelPrefix} selector hidden: ${step.expect.selectorHidden}`);
        } catch (error) {
          failures.push(
            `${labelPrefix} expected selector "${step.expect.selectorHidden}" not hidden within ${expectTimeout}ms (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (step.expect.nonblankCanvasMin && step.expect.nonblankCanvasMin > 0) {
        const min = step.expect.nonblankCanvasMin;
        const nonblank = await page.evaluate(() => {
          let count = 0;
          for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
            try {
              const context = canvas.getContext('2d', { willReadFrequently: true });
              if (!context || canvas.width <= 0 || canvas.height <= 0) continue;
              const x = Math.floor(canvas.width / 2);
              const y = Math.floor(canvas.height / 2);
              const pixel = context.getImageData(x, y, 1, 1).data;
              if (pixel[3] > 8 && pixel[0] + pixel[1] + pixel[2] > 28) count += 1;
            } catch {
              // ignore tainted canvas
            }
          }
          return count;
        });
        if (nonblank >= min) {
          checks.push(`${labelPrefix} nonblank canvas ${nonblank} ≥ ${min}`);
        } else {
          failures.push(`${labelPrefix} nonblank canvas count ${nonblank} < required ${min}`);
        }
      }
    }
  } catch (error) {
    failures.push(`${labelPrefix} action ${step.action.type} threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    label: step.label,
    viewport,
    action: step.action,
    passed: failures.length === 0,
    durationMs: Date.now() - startedAt,
    failures,
    checks,
  };
}

export async function runBrowserVisualSmoke(
  filePath: string,
  timeoutMs: number,
): Promise<BrowserVisualSmokeSummary>;
export async function runBrowserVisualSmoke(
  filePath: string,
  options: BrowserVisualSmokeOptions,
): Promise<BrowserVisualSmokeSummary>;
export async function runBrowserVisualSmoke(
  filePath: string,
  optionsOrTimeout: number | BrowserVisualSmokeOptions = DEFAULT_BROWSER_VISUAL_SMOKE_TIMEOUT_MS,
): Promise<BrowserVisualSmokeSummary> {
  const { timeoutMs, interactions } = normalizeVisualSmokeOptions(optionsOrTimeout);
  const resolution = resolveBrowserProvider();
  if (resolution.provider === 'system-chrome-cdp' && (resolution.missingExecutable || !resolution.systemExecutable)) {
    return runComputerUseVisualFallback(
      filePath,
      resolution.recommendedAction || 'System Chrome executable is missing.',
      interactions,
    );
  }

  const checks: string[] = [];
  const failures: string[] = [];
  const viewportDiagnostics: NonNullable<BrowserVisualSmokeDiagnostics['viewports']> = [];
  const interactionResults: BrowserInteractionStepResult[] = [];
  let latestTitle = '';
  let latestBodyTextLength = 0;
  let latestVisibleElements = 0;
  let metaPresent = false;
  let testPresent = false;
  let totalCanvasCount = 0;
  let totalNonblankCanvasCount = 0;
  let browser: import('playwright').Browser | null = null;
  let chromeProcess: ChildProcess | null = null;
  let profileDir: string | null = null;
  let stderr = '';
  let launchSlot: LaunchSlot | null = null;

  try {
    const playwright = await loadPlaywrightChromium();
    if (!playwright.ok || !playwright.chromium) {
      return runComputerUseVisualFallback(
        filePath,
        playwright.error || 'Playwright package unavailable.',
        interactions,
      );
    }
    launchSlot = await acquireLaunchSlot();
    const { chromium } = playwright;
    const startedAt = Date.now();
    const remaining = () => Math.max(1200, timeoutMs - (Date.now() - startedAt));
    let page: import('playwright').Page | null = null;

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
      const port = await findAvailablePort();
      const visualProfileDir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-visual-'));
      profileDir = visualProfileDir;
      const executable = launchResolution.systemExecutable;
      if (launchResolution.missingExecutable || !executable) {
        throw new Error(launchResolution.recommendedAction || 'System Chrome executable is missing.');
      }
      const chromeArgs = [
        ...buildSystemChromeCdpArgs({
          cdpPort: port,
          profileDir: visualProfileDir,
          headless: true,
          viewport: { width: 1280, height: 720 },
        }),
        pathToFileURL(filePath).href,
      ];

      const spawnedChrome = spawn(executable, chromeArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      chromeProcess = spawnedChrome;
      spawnedChrome.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
      });

      await waitForCdpEndpoint(port, spawnedChrome, Math.min(remaining(), 8000));
      browser = await chromium.connectOverCDP(await resolveCdpEndpointUrl(port));
      const context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = context.pages()[0] || await context.newPage();
    };

    if (resolution.provider === 'system-chrome-cdp') {
      await launchSystemChromePage(resolution);
    } else {
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
        });
        page = await context.newPage();
      } catch (error) {
        await browser?.close().catch(() => undefined);
        browser = null;
        if (resolution.provider === 'playwright-bundled') {
          const fallbackResolution = resolveBrowserProvider({ requestedProvider: 'system-chrome-cdp' });
          try {
            await launchSystemChromePage(fallbackResolution);
            checks.push('browser visual smoke fell back to system Chrome CDP because Playwright bundled Chromium is unavailable');
          } catch {
            await cleanupSystemChromeAttempt();
          }
        }
        if (!page) throw error;
      }
    }
    if (!page) {
      throw new Error('Browser page was not created for visual smoke.');
    }

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    for (const viewport of BROWSER_VISUAL_SMOKE_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(pathToFileURL(filePath).href, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await page.waitForTimeout(350);

      const probe = await page.evaluate((viewportName) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const documentElement = document.documentElement;
        const body = document.body;
        const canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
          const rect = canvas.getBoundingClientRect();
          const visibleWidth = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
          const visibleArea = visibleWidth * visibleHeight;
          const area = Math.max(0, rect.width * rect.height);
          let coloredPixels = 0;
          let sampledPixels = 0;
          let sampleError: string | null = null;

          try {
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context && canvas.width > 0 && canvas.height > 0) {
              const columns = Math.min(10, Math.max(1, Math.floor(canvas.width / 40)));
              const rows = Math.min(10, Math.max(1, Math.floor(canvas.height / 40)));
              for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < columns; column += 1) {
                  const x = Math.min(canvas.width - 1, Math.floor((column + 0.5) * canvas.width / columns));
                  const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / rows));
                  const pixel = context.getImageData(x, y, 1, 1).data;
                  sampledPixels += 1;
                  if (pixel[3] > 8 && pixel[0] + pixel[1] + pixel[2] > 28) {
                    coloredPixels += 1;
                  }
                }
              }
            }
          } catch (error) {
            sampleError = error instanceof Error ? error.message : String(error);
          }

          return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            visibleRatio: area > 0 ? visibleArea / area : 0,
            internalWidth: canvas.width,
            internalHeight: canvas.height,
            sampledPixels,
            coloredPixels,
            sampleError,
          };
        });
        const visibleElements = [...document.body.querySelectorAll('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 4
              && rect.height > 4
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
          })
          .length;
        const metadataWindow = window as Window & {
          __GAME_META__?: unknown;
          __INTERACTIVE_META__?: unknown;
          __GAME_TEST__?: unknown;
          __INTERACTIVE_TEST__?: unknown;
        };
        const interactiveMeta = metadataWindow.__INTERACTIVE_META__;
        const interactiveMetaRecord = Boolean(interactiveMeta)
          && typeof interactiveMeta === 'object'
          && !Array.isArray(interactiveMeta)
          ? interactiveMeta as Record<string, unknown>
          : null;
        const gameMetaPresent = Boolean(metadataWindow.__GAME_META__)
          || interactiveMetaRecord?.domain === 'game';

        return {
          viewportName,
          viewport,
          title: document.title,
          bodyTextLength: body?.innerText?.trim().length || 0,
          metaPresent: Boolean(metadataWindow.__GAME_META__ || metadataWindow.__INTERACTIVE_META__),
          gameMetaPresent,
          testPresent: Boolean(metadataWindow.__GAME_TEST__ || metadataWindow.__INTERACTIVE_TEST__),
          documentWidth: documentElement.scrollWidth,
          documentHeight: documentElement.scrollHeight,
          horizontalOverflow: documentElement.scrollWidth > viewport.width + 4,
          canvases,
          visibleElements,
        };
      }, viewport.name);

      const canvasCount = probe.canvases.length;
      const visibleCanvasCount = probe.canvases.filter((canvas) =>
        canvas.width >= 16
        && canvas.height >= 16
        && canvas.visibleRatio >= 0.82,
      ).length;
      const sampledCanvases = probe.canvases.filter((canvas) => canvas.sampledPixels > 0);
      const coloredCanvases = sampledCanvases.filter((canvas) => canvas.coloredPixels > 0);
      const horizontallyClippedCanvas = probe.canvases.some((canvas) =>
        canvas.left < -4 || canvas.right > probe.viewport.width + 4,
      );

      latestTitle = probe.title || latestTitle;
      latestBodyTextLength = probe.bodyTextLength;
      latestVisibleElements = probe.visibleElements;
      metaPresent = metaPresent || probe.metaPresent;
      testPresent = testPresent || probe.testPresent;
      totalCanvasCount = Math.max(totalCanvasCount, canvasCount);
      totalNonblankCanvasCount = Math.max(totalNonblankCanvasCount, coloredCanvases.length);
      viewportDiagnostics.push({
        name: viewport.name,
        width: probe.viewport.width,
        height: probe.viewport.height,
        documentWidth: probe.documentWidth,
        documentHeight: probe.documentHeight,
        canvasCount,
        nonblankCanvasCount: coloredCanvases.length,
        visibleElements: probe.visibleElements,
        horizontalOverflow: probe.horizontalOverflow,
        canvasFrames: probe.canvases.map((canvas) => ({
          width: roundMetric(canvas.width),
          height: roundMetric(canvas.height),
          left: roundMetric(canvas.left),
          top: roundMetric(canvas.top),
          right: roundMetric(canvas.right),
          bottom: roundMetric(canvas.bottom),
          visibleRatio: roundMetric(canvas.visibleRatio),
          internalWidth: canvas.internalWidth,
          internalHeight: canvas.internalHeight,
        })),
      });

      if (canvasCount > 0 && visibleCanvasCount === 0) {
        failures.push(
          `${viewport.name} visual smoke found canvas elements but none are visibly framed in the viewport (viewport=${probe.viewport.width}x${probe.viewport.height}, document=${probe.documentWidth}x${probe.documentHeight}, canvas=${formatCanvasFrames(probe.canvases)}). ${mobileCanvasRepairHint(probe.viewport.width)}`,
        );
      } else if (canvasCount > 0) {
        checks.push(`${viewport.name} visual smoke framed ${visibleCanvasCount}/${canvasCount} canvas element(s)`);
      }

      if (probe.gameMetaPresent && canvasCount > 0) {
        if (hasGameCanvasAspectRatioMismatch(probe.canvases)) {
          failures.push(
            `${viewport.name} visual smoke detected distorted game canvas aspect ratio (canvas=${formatCanvasFrames(probe.canvases)}). Repair hint: keep CSS aspect-ratio, rendered width/height, and canvas internal width/height consistent so the game is not stretched.`,
          );
        }
        if (isPrimaryGameCanvasUndersizedForViewport(probe.canvases, probe.viewport)) {
          failures.push(
            `${viewport.name} visual smoke primary game canvas is undersized for the preview surface (viewport=${probe.viewport.width}x${probe.viewport.height}, canvas=${formatCanvasFrames(probe.canvases)}). ${wideCanvasRepairHint()}`,
          );
        } else {
          checks.push(`${viewport.name} visual smoke primary game canvas uses the preview surface`);
        }
      }

      if (sampledCanvases.length > 0 && coloredCanvases.length === 0) {
        failures.push(`${viewport.name} visual smoke sampled canvas pixels but found no nonblank rendered content.`);
      } else if (coloredCanvases.length > 0) {
        checks.push(`${viewport.name} visual smoke found nonblank canvas pixels`);
      }

      if (canvasCount === 0 && probe.bodyTextLength === 0 && probe.visibleElements < 2) {
        failures.push(`${viewport.name} visual smoke found no canvas and too little visible DOM content.`);
      } else if (canvasCount === 0) {
        checks.push(`${viewport.name} visual smoke found visible DOM content`);
      }

      if (probe.horizontalOverflow && horizontallyClippedCanvas) {
        failures.push(
          `${viewport.name} visual smoke detected horizontal canvas overflow (viewportWidth=${probe.viewport.width}, documentWidth=${probe.documentWidth}, canvas=${formatCanvasFrames(probe.canvases)}); the game is likely cropped in this viewport. ${mobileCanvasRepairHint(probe.viewport.width)}`,
        );
      } else {
        checks.push(`${viewport.name} visual smoke detected no horizontal canvas cropping`);
      }

      const applicableSteps = viewport.name === 'wide-desktop'
        ? []
        : interactions.filter((step) => stepAppliesToViewport(step, viewport.name));
      for (const step of applicableSteps) {
        const stepResult = await runInteractionStep(page, step, viewport.name);
        interactionResults.push(stepResult);
        for (const check of stepResult.checks) {
          checks.push(`interaction ${check}`);
        }
        for (const failure of stepResult.failures) {
          failures.push(`interaction ${failure}`);
        }
      }
    }

    if (pageErrors.length > 0) {
      failures.push(`browser visual smoke saw runtime page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    if (consoleErrors.length > 0) {
      failures.push(`browser visual smoke saw console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    }

    if (failures.length === 0) {
      checks.unshift(
        resolution.provider === 'playwright-bundled'
          ? 'browser visual smoke passed via Playwright bundled Chromium'
          : 'browser visual smoke passed via system Chrome CDP',
      );
    }

    return {
      attempted: true,
      passed: failures.length === 0,
      failures,
      checks,
      diagnostics: {
        title: latestTitle,
        metaPresent,
        testPresent,
        canvasCount: totalCanvasCount,
        nonblankCanvasCount: totalNonblankCanvasCount,
        visibleElements: latestVisibleElements,
        bodyTextLength: latestBodyTextLength,
        consoleErrors: consoleErrors.slice(0, 5),
        pageErrors: pageErrors.slice(0, 5),
        viewports: viewportDiagnostics,
        interactions: interactionResults.length > 0 ? interactionResults : undefined,
      },
    };
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      failures: [
        `无法运行 browser visual smoke: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr.slice(-1200)}` : ''}`,
      ],
      checks,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChromeProcess(chromeProcess).catch(() => undefined);
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
    launchSlot?.release();
  }
}
