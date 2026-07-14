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
import { ARTIFACT_PREVIEW_HEALTH } from '../../../../shared/constants/previewHealth';
import { formatPreviewHealthMessage } from '../../../../shared/i18n/previewHealth';
import { createLogger } from '../../../services/infra/logger';
import { app } from '../../../platform';
import { waitForCdpEndpoint, stopChromeProcess } from './chromeProcess';
import {
  artifactFileUrl,
  collectArtifactPreviewHealthDiagnosticsFromPage,
  normalizeArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthOptions,
} from './artifactPreviewHealthProbe';
import {
  createArtifactPreviewHealthFinding,
  evaluateArtifactPreviewHealthDiagnostics,
  type ArtifactPreviewHealthFinding,
} from './artifactPreviewHealthEvaluator';
import {
  isInAppArtifactPreviewHealthUnavailable,
  runInAppArtifactPreviewHealth,
} from './inAppArtifactPreviewHealth';
import { loadPlaywrightChromium } from './playwrightRuntime';

const logger = createLogger('ArtifactPreviewHealth');

export type {
  ArtifactPreviewHealthDiagnostics,
  ArtifactPreviewHealthOptions,
  ArtifactPreviewHealthViewportDiagnostics,
} from './artifactPreviewHealthProbe';
export {
  createArtifactPreviewHealthFinding,
  evaluateArtifactPreviewHealthDiagnostics,
};
export type {
  ArtifactPreviewHealthFinding,
  ArtifactPreviewHealthFindingCode,
} from './artifactPreviewHealthEvaluator';

export interface ArtifactPreviewHealthSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  findings: ArtifactPreviewHealthFinding[];
  failures: string[];
  checks: string[];
  diagnostics?: ArtifactPreviewHealthDiagnostics;
  route?: string;
  fallbackReason?: string;
}

function getPreviewHealthLocale(options?: ArtifactPreviewHealthOptions): string | null {
  return options?.locale ?? app.getLocale?.() ?? null;
}

function skippedArtifactPreviewHealth(reason: string, locale?: string | null): ArtifactPreviewHealthSummary {
  return {
    attempted: false,
    skipped: true,
    passed: true,
    findings: [],
    failures: [],
    checks: [formatPreviewHealthMessage('skipped', { reason }, locale)],
  };
}

export async function runSelfStartedArtifactPreviewHealth(
  filePath: string,
  options: ArtifactPreviewHealthOptions = {},
): Promise<ArtifactPreviewHealthSummary> {
  const timeoutMs = options.timeoutMs ?? ARTIFACT_PREVIEW_HEALTH.TIMEOUT_MS;
  const viewports = options.viewports?.length ? options.viewports : ARTIFACT_PREVIEW_HEALTH.VIEWPORTS;
  const initialViewport = viewports[0] ?? ARTIFACT_PREVIEW_HEALTH.VIEWPORTS[0];
  const mainElementSelectors = options.mainElementSelectors ?? ARTIFACT_PREVIEW_HEALTH.MAIN_ELEMENT_SELECTORS;
  const locale = getPreviewHealthLocale(options);
  const resolution = resolveBrowserProvider();
  if (resolution.provider === 'system-chrome-cdp' && (resolution.missingExecutable || !resolution.systemExecutable)) {
    return skippedArtifactPreviewHealth(resolution.recommendedAction || 'System Chrome executable is missing.', locale);
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
      return skippedArtifactPreviewHealth(playwright.error || 'Playwright package unavailable.', locale);
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
          mockKeychain: true,
        }),
        artifactFileUrl(filePath),
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

    const diagnostics = normalizeArtifactPreviewHealthDiagnostics(
      await collectArtifactPreviewHealthDiagnosticsFromPage({
        page,
        url: artifactFileUrl(filePath),
        timeoutMs,
        viewports,
        mainElementSelectors,
      }),
      { artifactPath: filePath },
    );
    const findings = evaluateArtifactPreviewHealthDiagnostics(diagnostics);
    if (findings.length === 0) {
      checks.unshift(
        formatPreviewHealthMessage('routeSelfStartedPassed', {
          provider: resolution.provider === 'playwright-bundled'
            ? 'Playwright bundled Chromium'
            : 'system Chrome CDP',
        }, locale),
      );
    }
    checks.push(formatPreviewHealthMessage('inspectedViewports', { count: diagnostics.viewports.length }, locale));

    return {
      attempted: true,
      passed: findings.length === 0,
      findings,
      failures: findings.map((item) => item.message),
      checks,
      diagnostics,
      route: ARTIFACT_PREVIEW_HEALTH.ROUTES.SELF_STARTED_CHROME,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      passed: false,
      findings: [
        createArtifactPreviewHealthFinding(
          'page_error',
          formatPreviewHealthMessage('unableToRun', { reason: message }, locale),
          undefined,
          stderr ? { stderr: stderr.slice(-ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT) } : undefined,
        ),
      ],
      failures: [
        `${formatPreviewHealthMessage('unableToRun', { reason: message }, locale)}${stderr ? `\n${stderr.slice(-ARTIFACT_PREVIEW_HEALTH.STDERR_LIMIT)}` : ''}`,
      ],
      checks,
      route: ARTIFACT_PREVIEW_HEALTH.ROUTES.SELF_STARTED_CHROME,
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

export async function runArtifactPreviewHealth(
  filePath: string,
  options: ArtifactPreviewHealthOptions = {},
): Promise<ArtifactPreviewHealthSummary> {
  const locale = getPreviewHealthLocale(options);
  try {
    return await runInAppArtifactPreviewHealth(filePath, {
      ...options,
      locale,
    });
  } catch (error) {
    const reason = isInAppArtifactPreviewHealthUnavailable(error)
      ? error.message
      : formatPreviewHealthMessage('inAppUnavailable', {
          reason: error instanceof Error ? error.message : String(error),
        }, locale);
    logger.warn('Artifact preview health falling back to self-started Chrome', {
      route: ARTIFACT_PREVIEW_HEALTH.ROUTES.SELF_STARTED_CHROME,
      reason: isInAppArtifactPreviewHealthUnavailable(error) ? error.reasonCode : 'in_app_runner_error',
    });
    const fallback = await runSelfStartedArtifactPreviewHealth(filePath, options);
    return {
      ...fallback,
      checks: [
        formatPreviewHealthMessage('routeFallback', { reason }, locale),
        ...(isInAppArtifactPreviewHealthUnavailable(error) ? error.checks : []),
        ...fallback.checks,
      ],
      route: ARTIFACT_PREVIEW_HEALTH.ROUTES.SELF_STARTED_CHROME,
      fallbackReason: reason,
    };
  }
}
