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
import { acquireLaunchSlot, type LaunchSlot } from '../../../services/infra/playwrightLaunchSemaphore';
import { ARTIFACT_PREVIEW_HEALTH } from '../../../../shared/constants/previewHealth';
import { waitForCdpEndpoint, stopChromeProcess } from './chromeProcess';
import { loadPlaywrightChromium } from './playwrightRuntime';

export type ArtifactPreviewHealthFindingCode =
  | 'blank_body_text'
  | 'horizontal_overflow'
  | 'console_error'
  | 'page_error'
  | 'broken_image'
  | 'missing_main_element'
  | 'responsive_breakpoint_failure';

export interface ArtifactPreviewHealthFinding {
  code: ArtifactPreviewHealthFindingCode;
  message: string;
  viewport?: string;
  evidence?: Record<string, boolean | number | string | string[]>;
}

export interface ArtifactPreviewHealthViewportDiagnostics {
  name: string;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  bodyTextLength: number;
  visibleElements: number;
  horizontalOverflow: boolean;
  mainElement: {
    present: boolean;
    selector?: string;
  };
  brokenImages: Array<{
    src: string;
    alt?: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
  }>;
}

export interface ArtifactPreviewHealthDiagnostics {
  title?: string;
  consoleErrors: string[];
  pageErrors: string[];
  viewports: ArtifactPreviewHealthViewportDiagnostics[];
}

export interface ArtifactPreviewHealthSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  findings: ArtifactPreviewHealthFinding[];
  failures: string[];
  checks: string[];
  diagnostics?: ArtifactPreviewHealthDiagnostics;
}

export interface ArtifactPreviewHealthOptions {
  timeoutMs?: number;
  mainElementSelectors?: readonly string[];
  viewports?: readonly { name: string; width: number; height: number }[];
}

function skippedArtifactPreviewHealth(reason: string): ArtifactPreviewHealthSummary {
  return {
    attempted: false,
    skipped: true,
    passed: true,
    findings: [],
    failures: [],
    checks: [`artifact preview health skipped: ${reason}`],
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function finding(
  code: ArtifactPreviewHealthFindingCode,
  message: string,
  viewport?: string,
  evidence?: ArtifactPreviewHealthFinding['evidence'],
): ArtifactPreviewHealthFinding {
  return {
    code,
    message,
    ...(viewport ? { viewport } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function evaluateArtifactPreviewHealthDiagnostics(
  diagnostics: ArtifactPreviewHealthDiagnostics,
): ArtifactPreviewHealthFinding[] {
  const findings: ArtifactPreviewHealthFinding[] = [];
  const viewportFindingCodes = new Map<string, Set<ArtifactPreviewHealthFindingCode>>();

  const addViewportFinding = (
    viewport: ArtifactPreviewHealthViewportDiagnostics,
    code: ArtifactPreviewHealthFindingCode,
    message: string,
    evidence?: ArtifactPreviewHealthFinding['evidence'],
  ) => {
    findings.push(finding(code, message, viewport.name, evidence));
    const codes = viewportFindingCodes.get(viewport.name) ?? new Set<ArtifactPreviewHealthFindingCode>();
    codes.add(code);
    viewportFindingCodes.set(viewport.name, codes);
  };

  for (const viewport of diagnostics.viewports) {
    if (viewport.bodyTextLength === 0) {
      addViewportFinding(
        viewport,
        'blank_body_text',
        `${viewport.name} preview body text is empty.`,
        { bodyTextLength: viewport.bodyTextLength },
      );
    }

    if (viewport.horizontalOverflow) {
      addViewportFinding(
        viewport,
        'horizontal_overflow',
        `${viewport.name} preview overflows horizontally.`,
        {
          viewportWidth: viewport.width,
          documentWidth: viewport.documentWidth,
        },
      );
    }

    if (viewport.brokenImages.length > 0) {
      addViewportFinding(
        viewport,
        'broken_image',
        `${viewport.name} preview contains broken image(s).`,
        {
          count: viewport.brokenImages.length,
          src: viewport.brokenImages.slice(0, 3).map((image) => image.src),
        },
      );
    }

    if (!viewport.mainElement.present) {
      addViewportFinding(
        viewport,
        'missing_main_element',
        `${viewport.name} preview is missing a visible main artifact element.`,
        { visibleElements: viewport.visibleElements },
      );
    }
  }

  for (const error of uniqueStrings(diagnostics.consoleErrors).slice(0, 5)) {
    findings.push(finding('console_error', `Preview console error: ${error}`, undefined, { text: error }));
  }

  for (const error of uniqueStrings(diagnostics.pageErrors).slice(0, 5)) {
    findings.push(finding('page_error', `Preview runtime page error: ${error}`, undefined, { text: error }));
  }

  const viewportSpecificCodes = new Set<ArtifactPreviewHealthFindingCode>();
  for (const code of ['blank_body_text', 'horizontal_overflow', 'broken_image', 'missing_main_element'] as const) {
    const affectedViewports = diagnostics.viewports
      .filter((viewport) => viewportFindingCodes.get(viewport.name)?.has(code))
      .map((viewport) => viewport.name);
    if (affectedViewports.length > 0 && affectedViewports.length < diagnostics.viewports.length) {
      viewportSpecificCodes.add(code);
    }
  }
  if (viewportSpecificCodes.size > 0) {
    const failingViewportNames = diagnostics.viewports
      .filter((viewport) => {
        const codes = viewportFindingCodes.get(viewport.name);
        return codes && [...viewportSpecificCodes].some((code) => codes.has(code));
      })
      .map((viewport) => viewport.name);
    const healthyViewportNames = diagnostics.viewports
      .filter((viewport) => !failingViewportNames.includes(viewport.name))
      .map((viewport) => viewport.name);
    findings.push(finding(
      'responsive_breakpoint_failure',
      `Preview health differs by viewport; failing viewport(s): ${failingViewportNames.join(', ')}.`,
      undefined,
      {
        failingViewports: failingViewportNames,
        healthyViewports: healthyViewportNames,
        viewportSpecificCodes: [...viewportSpecificCodes],
      },
    ));
  }

  return findings;
}

export async function runArtifactPreviewHealth(
  filePath: string,
  options: ArtifactPreviewHealthOptions = {},
): Promise<ArtifactPreviewHealthSummary> {
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PREVIEW_HEALTH.TIMEOUT_MS;
  const viewports = options.viewports?.length ? options.viewports : ARTIFACT_PREVIEW_HEALTH.VIEWPORTS;
  const initialViewport = viewports[0] ?? ARTIFACT_PREVIEW_HEALTH.VIEWPORTS[0];
  const mainElementSelectors = options.mainElementSelectors ?? ARTIFACT_PREVIEW_HEALTH.MAIN_ELEMENT_SELECTORS;
  const resolution = resolveBrowserProvider();
  if (resolution.provider === 'system-chrome-cdp' && (resolution.missingExecutable || !resolution.systemExecutable)) {
    return skippedArtifactPreviewHealth(resolution.recommendedAction || 'System Chrome executable is missing.');
  }

  const checks: string[] = [];
  let browser: import('playwright').Browser | null = null;
  let chromeProcess: ChildProcess | null = null;
  let profileDir: string | null = null;
  let stderr = '';
  let launchSlot: LaunchSlot | null = null;

  try {
    const playwright = await loadPlaywrightChromium();
    if (!playwright.ok || !playwright.chromium) {
      return skippedArtifactPreviewHealth(playwright.error || 'Playwright package unavailable.');
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
      const healthProfileDir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-preview-health-'));
      profileDir = healthProfileDir;
      const executable = launchResolution.systemExecutable;
      if (launchResolution.missingExecutable || !executable) {
        throw new Error(launchResolution.recommendedAction || 'System Chrome executable is missing.');
      }
      const chromeArgs = [
        ...buildSystemChromeCdpArgs({
          cdpPort: port,
          profileDir: healthProfileDir,
          headless: true,
          viewport: { width: initialViewport.width, height: initialViewport.height },
        }),
        pathToFileURL(filePath).href,
      ];

      const spawnedChrome = spawn(executable, chromeArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      chromeProcess = spawnedChrome;
      spawnedChrome.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT) {
          stderr = stderr.slice(-ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT);
        }
      });

      await waitForCdpEndpoint(
        port,
        spawnedChrome,
        Math.min(remaining(), ARTIFACT_PREVIEW_HEALTH.CDP_CONNECT_TIMEOUT_MS),
      );
      browser = await chromium.connectOverCDP(await resolveCdpEndpointUrl(port));
      const context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: initialViewport.width, height: initialViewport.height },
      });
      page = context.pages()[0] || await context.newPage();
    };

    if (resolution.provider === 'system-chrome-cdp') {
      await launchSystemChromePage(resolution);
    } else {
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: initialViewport.width, height: initialViewport.height },
        });
        page = await context.newPage();
      } catch (error) {
        await browser?.close().catch(() => undefined);
        browser = null;
        if (resolution.provider === 'playwright-bundled') {
          const fallbackResolution = resolveBrowserProvider({ requestedProvider: 'system-chrome-cdp' });
          try {
            await launchSystemChromePage(fallbackResolution);
            checks.push('artifact preview health fell back to system Chrome CDP because Playwright bundled Chromium is unavailable');
          } catch {
            await cleanupSystemChromeAttempt();
          }
        }
        if (!page) throw error;
      }
    }

    if (!page) {
      throw new Error('Browser page was not created for artifact preview health.');
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

    const viewportDiagnostics: ArtifactPreviewHealthViewportDiagnostics[] = [];
    let latestTitle = '';

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(pathToFileURL(filePath).href, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      await page.waitForTimeout(ARTIFACT_PREVIEW_HEALTH.SETTLE_MS);

      const probe = await page.evaluate(({ selectors, minVisibleSize, overflowTolerance }) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const documentElement = document.documentElement;
        const body = document.body;

        const visibleElements = [...document.body.querySelectorAll('*')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > minVisibleSize
              && rect.height > minVisibleSize
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && Number(style.opacity || '1') !== 0
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
          })
          .length;

        let mainElementSelector: string | undefined;
        for (const selector of selectors) {
          try {
            const element = document.querySelector(selector);
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const visible = rect.width > minVisibleSize
              && rect.height > minVisibleSize
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && Number(style.opacity || '1') !== 0
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= viewport.height
              && rect.left <= viewport.width;
            if (visible) {
              mainElementSelector = selector;
              break;
            }
          } catch {
            // Invalid custom selectors are ignored; default selectors are static.
          }
        }

        const brokenImages = [...document.images]
          .filter((image) => image.naturalWidth === 0)
          .map((image) => ({
            src: image.currentSrc || image.src || '',
            alt: image.alt || undefined,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
          }));

        return {
          title: document.title,
          viewport,
          documentWidth: documentElement.scrollWidth,
          documentHeight: documentElement.scrollHeight,
          bodyTextLength: body?.innerText?.trim().length || 0,
          visibleElements,
          horizontalOverflow: documentElement.scrollWidth > viewport.width + overflowTolerance,
          mainElement: {
            present: Boolean(mainElementSelector),
            selector: mainElementSelector,
          },
          brokenImages,
        };
      }, {
        selectors: [...mainElementSelectors],
        minVisibleSize: ARTIFACT_PREVIEW_HEALTH.VISIBLE_ELEMENT_MIN_SIZE_PX,
        overflowTolerance: ARTIFACT_PREVIEW_HEALTH.OVERFLOW_TOLERANCE_PX,
      });

      latestTitle = probe.title || latestTitle;
      viewportDiagnostics.push({
        name: viewport.name,
        width: probe.viewport.width,
        height: probe.viewport.height,
        documentWidth: probe.documentWidth,
        documentHeight: probe.documentHeight,
        bodyTextLength: probe.bodyTextLength,
        visibleElements: probe.visibleElements,
        horizontalOverflow: probe.horizontalOverflow,
        mainElement: probe.mainElement,
        brokenImages: probe.brokenImages,
      });
    }

    const diagnostics: ArtifactPreviewHealthDiagnostics = {
      title: latestTitle,
      consoleErrors: consoleErrors.slice(0, 10),
      pageErrors: pageErrors.slice(0, 10),
      viewports: viewportDiagnostics,
    };
    const findings = evaluateArtifactPreviewHealthDiagnostics(diagnostics);
    if (findings.length === 0) {
      checks.unshift(
        resolution.provider === 'playwright-bundled'
          ? 'artifact preview health passed via Playwright bundled Chromium'
          : 'artifact preview health passed via system Chrome CDP',
      );
    }
    checks.push(`artifact preview health inspected ${viewportDiagnostics.length} viewport(s)`);

    return {
      attempted: true,
      passed: findings.length === 0,
      findings,
      failures: findings.map((item) => item.message),
      checks,
      diagnostics,
    };
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      findings: [
        finding(
          'page_error',
          `Unable to run artifact preview health: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          stderr ? { stderr: stderr.slice(-ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT) } : undefined,
        ),
      ],
      failures: [
        `Unable to run artifact preview health: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr.slice(-ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT)}` : ''}`,
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
