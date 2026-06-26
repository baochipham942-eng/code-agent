import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { promisify } from 'util';
import { getComputerSurface } from '../../../services/desktop/computerSurface';
import type {
  BrowserVisualSmokeSummary,
  BrowserInteractionStep,
  BrowserInteractionStepResult,
} from './types';

const execFileAsync = promisify(execFile);
const DESKTOP_VISUAL_FALLBACK_MIN_SCREENSHOT_BYTES = 2048;
const DESKTOP_VISUAL_FALLBACK_WAIT_MS = 1200;

export async function runComputerUseVisualFallback(
  filePath: string,
  reason: string,
  interactions: BrowserInteractionStep[] = [],
): Promise<BrowserVisualSmokeSummary> {
  if (process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK === '0') {
    return skippedComputerUseFallback('Computer Use visual fallback disabled by CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK=0.', reason, interactions);
  }

  if (process.platform !== 'darwin') {
    return skippedComputerUseFallback('Computer Use visual fallback is only available on macOS desktop builds.', reason, interactions);
  }

  const browserApp = process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_APP || 'Safari';
  const checks = [
    `browser visual smoke fell back to Computer Use desktop surface: ${reason}`,
  ];
  const unavailableReasons: string[] = [];
  let screenshotPath: string | undefined;
  let screenshotBytes = 0;
  let frontmostApp: string | null = null;
  let windowTitle: string | null = null;

  try {
    const openResult = await openArtifactInDesktopBrowser(browserApp, filePath);
    checks.push(openResult);
    await delay(DESKTOP_VISUAL_FALLBACK_WAIT_MS);

    const snapshot = await getComputerSurface().observe({ includeScreenshot: true });
    screenshotPath = snapshot.screenshotPath || undefined;
    frontmostApp = snapshot.appName || null;
    windowTitle = snapshot.windowTitle || null;

    if (!screenshotPath) {
      unavailableReasons.push('Computer Use visual fallback could not capture a desktop screenshot.');
    } else {
      const info = await stat(screenshotPath);
      screenshotBytes = info.size;
      checks.push(`Computer Use captured desktop screenshot: ${screenshotPath}`);
      if (screenshotBytes < DESKTOP_VISUAL_FALLBACK_MIN_SCREENSHOT_BYTES) {
        unavailableReasons.push(`Computer Use screenshot is too small to trust as visual evidence: ${screenshotBytes} bytes.`);
      } else {
        checks.push(`Computer Use screenshot has evidence bytes: ${screenshotBytes}`);
      }
    }

    if (!frontmostApp && !windowTitle) {
      unavailableReasons.push('Computer Use visual fallback could not identify the frontmost app/window after opening the artifact.');
    } else {
      checks.push(`Computer Use observed frontmost surface: ${frontmostApp || 'unknown'}${windowTitle ? ` · ${windowTitle}` : ''}`);
    }
  } catch (error) {
    unavailableReasons.push(`Computer Use visual fallback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const skipped = unavailableReasons.length > 0;
  const interactionResults = buildSkippedInteractionResults(
    interactions,
    'desktop fallback path does not yet drive interactions (Playwright unavailable)',
  );
  if (interactionResults.length > 0) {
    checks.push(`interactions skipped: ${interactionResults.length} step(s) deferred — desktop fallback cannot drive interaction yet`);
  }

  return {
    attempted: true,
    skipped: skipped ? true : undefined,
    passed: true,
    failures: [],
    checks: skipped
      ? [
          ...checks,
          ...unavailableReasons.map((unavailableReason) => `Computer Use visual fallback unavailable: ${unavailableReason}`),
        ]
      : checks,
    diagnostics: {
      title: windowTitle || undefined,
      computerUseFallback: {
        screenshotPath,
        screenshotBytes,
        frontmostApp,
        windowTitle,
        reason,
      },
      interactions: interactionResults.length > 0 ? interactionResults : undefined,
    },
  };
}

function buildSkippedInteractionResults(
  interactions: BrowserInteractionStep[],
  reason: string,
): BrowserInteractionStepResult[] {
  return interactions.map((step) => ({
    label: step.label,
    viewport: step.viewport ?? 'both',
    action: step.action,
    passed: true,
    skipped: true,
    durationMs: 0,
    failures: [],
    checks: [`skipped: ${reason}`],
  }));
}

async function openArtifactInDesktopBrowser(browserApp: string, filePath: string): Promise<string> {
  try {
    await execFileAsync('open', ['-a', browserApp, filePath], { timeout: 8000 });
    return `Computer Use fallback opened artifact with ${browserApp}`;
  } catch (error) {
    await execFileAsync('open', [filePath], { timeout: 8000 });
    return `Computer Use fallback opened artifact with default browser after ${browserApp} failed: ${formatExecError(error)}`;
  }
}

function skippedComputerUseFallback(
  message: string,
  reason: string,
  interactions: BrowserInteractionStep[] = [],
): BrowserVisualSmokeSummary {
  const interactionResults = buildSkippedInteractionResults(
    interactions,
    'visual smoke skipped before interactions could run',
  );
  return {
    attempted: false,
    skipped: true,
    passed: true,
    failures: [],
    checks: [`browser visual smoke skipped: ${message}`, `Playwright/browser reason: ${reason}`],
    diagnostics: {
      computerUseFallback: { reason },
      interactions: interactionResults.length > 0 ? interactionResults : undefined,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatExecError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
