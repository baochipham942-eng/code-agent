import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { PluginInstallDisclosure } from '../../../src/renderer/components/features/settings/tabs/PluginInstallDisclosure';
import { loadPlaywrightChromium } from '../../../src/host/agent/runtime/browser/playwrightRuntime';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

describe('plugin approval overlay visual evidence', () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    vite = await createServer({
      configFile: 'vite.config.ts',
      root: 'src/renderer',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    await vite.listen();
    const origin = vite.resolvedUrls?.local[0];
    if (!origin) throw new Error('Vite test origin unavailable');
    const playwright = await loadPlaywrightChromium();
    if (!playwright.ok || !playwright.chromium) {
      throw new Error(`Playwright Chromium unavailable: ${playwright.error ?? 'unknown error'}`);
    }
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const disclosure = renderToStaticMarkup(
      <PluginInstallDisclosure
        busy={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        preview={{
          token: 'visual-approval',
          id: 'timeline-studio',
          packageId: '2.0.0-visual',
          mode: 'update',
          approvalRequired: true,
          name: '时间线助手',
          version: '2.0.0',
          description: '把项目进展整理成可浏览的时间线。',
          permissions: ['storage'],
          toolNames: [],
          surface: 'ui',
          sourceKind: 'zip',
          sourceLabel: 'Timeline Studio',
          sourceTrust: { level: 'signed', reason: '已验证', keyId: 'publisher-42' },
          requestedUiSlots: ['settings.section'],
          replacesInstalledVersion: '1.4.0',
          sandbox: { passed: true, summary: '文件结构和运行入口检查已完成。' },
          expiresAt: Date.now() + 60_000,
        }}
        text={zh.settings.plugins.manualImport}
      />,
    );
    await page.setContent(
      `<!doctype html><html><head><link rel="stylesheet" href="${origin}styles/global.css"></head>`
      + '<body class="bg-zinc-950 text-zinc-200"><main class="min-h-screen bg-zinc-950">'
      + '<div class="p-8 text-sm text-zinc-600">Neo</div>'
      + disclosure
      + '</main></body></html>',
      { waitUntil: 'networkidle' },
    );
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it('renders both authorization choices and the explicit failure behavior', async () => {
    await expect(page.getByRole('button', { name: '仅允许这个版本' }).isVisible()).resolves.toBe(true);
    await expect(page.getByRole('button', { name: '也允许今后的版本' }).isVisible()).resolves.toBe(true);
    await expect(page.getByText('不会自动恢复运行', { exact: false }).isVisible()).resolves.toBe(true);
    const screenshotPath = process.env.PLUGIN_APPROVAL_SCREENSHOT_PATH;
    if (screenshotPath) {
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  });
});
