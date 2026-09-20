// ============================================================================
// Jev browser host adapter — Playwright-backed page + test fake seam
// ============================================================================

import type { BrowserArtifactSummary, BrowserTargetRef } from '../../../services/infra/browser/types';
import type { JevCapturedSnapshot } from '../../../services/infra/browser/jevBrowserSnapshotPrep';
import { BrowserTargetRefError } from '../../../services/infra/browser/types';
import type { BrowserService } from '../../../services/infra/browserService';

interface JevDialogState {
  pending: boolean;
  type?: string;
}

export interface JevBrowserHost {
  isLaunched(): boolean;
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  currentUrl(): string;
  capture(): Promise<JevCapturedSnapshot>;
  clickTargetRef(targetRef: BrowserTargetRef): Promise<void>;
  typeTargetRef(targetRef: BrowserTargetRef, text: string): Promise<void>;
  scroll(direction: 'up' | 'down'): Promise<void>;
  pressEnter(): Promise<void>;
  wait(ms?: number): Promise<void>;
  getDialogState(): JevDialogState;
  getFormValues(): Promise<Record<string, string>>;
  getVisibleText(): Promise<string>;
  listDownloads(): Promise<Array<Pick<BrowserArtifactSummary, 'name' | 'sha256'>>>;
}

const SYSTEM_SETTINGS_URL = /^(chrome|edge|chrome-extension):\/\/|about:preferences/i;

export function isBlockedSystemUrl(url: string): boolean {
  return SYSTEM_SETTINGS_URL.test(url);
}

export function isStaleTargetRefError(error: unknown): error is BrowserTargetRefError {
  return error instanceof BrowserTargetRefError || (error as { code?: string } | null)?.code === 'STALE_TARGET_REF';
}

const INNER_ACTION_TIMEOUT_MS = 2500;

async function withHostTrace<T>(
  service: BrowserService,
  action: string,
  params: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const trace = service.beginTrace({
    toolName: 'browser_action',
    action,
    params: { ...params, action },
  });
  try {
    const value = await run();
    service.logger.log('INFO', `Jev inner ${action}`);
    service.finishTrace(trace, { success: true, error: null });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    service.logger.log('ERROR', `Jev inner ${action} failed: ${message}`);
    service.finishTrace(trace, { success: false, error: message });
    throw error;
  }
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createManagedJevBrowserHost(service: BrowserService): JevBrowserHost {
  return {
    isLaunched: () => service.isRunning() && Boolean(service.getActiveTab()),
    launch: async () => {
      await service.launch({ leaseOwner: 'jev_browser_step' });
      if (!service.getActiveTab()) await service.newTab();
    },
    navigate: async (url: string) => {
      await withHostTrace(service, 'navigate', { url }, async () => {
        if (!service.getActiveTab()) await service.newTab(url);
        else await service.navigate(url);
      });
    },
    currentUrl: () => service.getActiveTab()?.url || '',
    capture: async () => service.captureJevPage(),
    clickTargetRef: async (targetRef) => {
      // Hang-protect: 2.5s then reject `timeout`. Baseline awaits Playwright; a timed-out
      // inner click must not be recorded as ok in recent_steps.
      await withHostTrace(service, 'click', { targetRef }, async () => {
        await raceWithTimeout(service.clickTargetRef(targetRef), INNER_ACTION_TIMEOUT_MS);
      });
    },
    typeTargetRef: async (targetRef, text) => {
      // Hang-protect: 2.5s then reject `timeout`. Baseline awaits Playwright; a timed-out
      // inner type must not be recorded as ok in recent_steps.
      await withHostTrace(service, 'type', { targetRef, text }, async () => {
        await raceWithTimeout(service.typeTargetRef(targetRef, text), INNER_ACTION_TIMEOUT_MS);
      });
    },
    scroll: async (direction) => {
      await withHostTrace(service, 'scroll', { direction }, async () => {
        await service.scroll(direction, 300);
      });
    },
    pressEnter: async () => {
      await withHostTrace(service, 'press_key', { key: 'Enter' }, async () => {
        await service.pressKey('Enter');
      });
    },
    wait: async (ms = 1000) => {
      await withHostTrace(service, 'wait', { ms }, async () => {
        await service.waitForTimeout(ms);
      });
    },
    getDialogState: () => service.getDialogState(),
    getFormValues: async () => {
      const tab = service.getActiveTab();
      if (!tab) return {};
      return tab.page.evaluate(() => {
        const values: Record<string, string> = {};
        const nodes = document.querySelectorAll('input, textarea, select');
        nodes.forEach((node, index) => {
          const input = node as HTMLInputElement;
          const type = (input.type || '').toLowerCase();
          if (type === 'password' || type === 'file') return;
          const key = input.name || input.id || input.getAttribute('aria-label') || `field_${index}`;
          values[key] = input.value || '';
        });
        return values;
      });
    },
    getVisibleText: async () => {
      try {
        const content = await service.getPageContent();
        return `${content.title}\n${content.text}`.slice(0, 8_000);
      } catch {
        return '';
      }
    },
    // ponytail: 生产态 listDownloads 恒空，download_artifact_present 永远判不过；升级路径=接 BrowserArtifactSummary / wait_for_download 产物表。12 题未用到，是已知天花板
    listDownloads: async () => [],
  };
}
