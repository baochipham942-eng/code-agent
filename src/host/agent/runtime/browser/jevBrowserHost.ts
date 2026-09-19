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
  evaluate<T>(script: string): Promise<T>;
}

const SYSTEM_SETTINGS_URL = /^(chrome|edge|chrome-extension):\/\/|about:preferences/i;

export function isBlockedSystemUrl(url: string): boolean {
  return SYSTEM_SETTINGS_URL.test(url);
}

export function isStaleTargetRefError(error: unknown): error is BrowserTargetRefError {
  return error instanceof BrowserTargetRefError || (error as { code?: string } | null)?.code === 'STALE_TARGET_REF';
}

export function createManagedJevBrowserHost(service: BrowserService): JevBrowserHost {
  return {
    isLaunched: () => service.isRunning() && Boolean(service.getActiveTab()),
    launch: async () => {
      await service.launch({ leaseOwner: 'jev_browser_step' });
      if (!service.getActiveTab()) await service.newTab();
    },
    navigate: async (url: string) => {
      if (!service.getActiveTab()) await service.newTab(url);
      else await service.navigate(url);
    },
    currentUrl: () => service.getActiveTab()?.url || '',
    capture: async () => service.captureJevPage(),
    clickTargetRef: async (targetRef) => {
      await Promise.race([
        service.clickTargetRef(targetRef),
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
    },
    typeTargetRef: async (targetRef, text) => {
      await Promise.race([
        service.typeTargetRef(targetRef, text),
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
    },
    scroll: async (direction) => {
      await service.scroll(direction, 300);
    },
    pressEnter: async () => {
      await service.pressKey('Enter');
    },
    wait: async (ms = 1000) => {
      await service.waitForTimeout(ms);
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
    listDownloads: async () => [],
    evaluate: async (script) => service.runScript(script),
  };
}
