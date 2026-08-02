import { mkdir } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { loadPlaywrightChromium } from '../../../src/host/agent/runtime/browser/playwrightRuntime';

interface AxisGeometry {
  rowCenterY: number;
  archiveCenterY: number;
  verticalOffsetPx: number;
  unreadCenterX: number;
  badgeCenterX: number;
  archiveRight: number;
  archiveMinusUnreadPx: number;
  archiveMinusBadgePx: number;
}

function renderRow(id: string, options: { unread?: boolean; badge?: boolean } = {}) {
  const session = {
    id,
    title: id,
    type: 'chat',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    turnCount: 1,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    metadata: options.badge ? { hadLiveVoice: true } : undefined,
  } as any;

  return renderToStaticMarkup(
    <SidebarSessionItem
      session={session}
      unreadSessionIds={options.unread ? new Set([id]) : new Set()}
      automationSummariesBySessionId={{}}
      currentSessionId={null}
      selectedSessionIds={new Set()}
      pinnedSessionIds={new Set()}
      renamingId={null}
      sessionRuntimes={new Map()}
      backgroundSessionMap={new Map()}
      sessionStates={{}}
      hasNeedsInputForSession={() => false}
      searchQuery=""
      messageSearchHitsBySessionId={{}}
      replayEvidenceBySessionId={new Map()}
      reviewItemsBySessionId={{}}
      trajectoryQualityBySessionId={{}}
      multiSelectMode={false}
      hoveredSession={null}
      renameValue=""
      renameInputRef={React.createRef<HTMLInputElement>()}
      setHoveredSession={vi.fn()}
      setRenameValue={vi.fn()}
      handleSelectSession={vi.fn()}
      handleContextMenu={vi.fn()}
      handleRenameSubmit={vi.fn()}
      handleRenameKeyDown={vi.fn()}
      handleDoubleClick={vi.fn()}
      handleOpenReplayEvidence={vi.fn()}
      handleSelectMessageSearchHit={vi.fn()}
      handleArchiveSession={vi.fn()}
    />,
  );
}

describe('SidebarSessionItem 归档按钮双轴几何', () => {
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
    page = await browser.newPage({ viewport: { width: 420, height: 300 }, deviceScaleFactor: 2 });
    await page.setContent(
      `<!doctype html><html><head><link rel="stylesheet" href="${origin}styles/global.css"></head>`
      + '<body class="bg-zinc-950 text-zinc-200"><main style="width:240px;margin:40px">'
      + renderRow('row-unread', { unread: true })
      + renderRow('row-badge', { badge: true })
      + renderRow('row-archive')
      + '</main></body></html>',
      { waitUntil: 'networkidle' },
    );

    const screenshotDir = process.env.ARCHIVE_ALIGNMENT_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.locator('main').screenshot({ path: `${screenshotDir}/archive-axis-non-hover.png` });
    }
    await page.locator('[data-session-id="row-archive"]').hover();
    await page.waitForTimeout(200);
    if (screenshotDir) {
      await page.locator('main').screenshot({ path: `${screenshotDir}/archive-axis-hover.png` });
    }
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it('① 归档按钮在会话行内垂直居中，并输出实际读数', async () => {
    const geometry = await readGeometry(page);
    console.info('[archive-axis vertical]', JSON.stringify({
      rowCenterY: geometry.rowCenterY,
      archiveCenterY: geometry.archiveCenterY,
      verticalOffsetPx: geometry.verticalOffsetPx,
    }));

    expect(geometry.verticalOffsetPx).toBeCloseTo(0, 2);
  });

  it('② 按钮右缘与未读点/徽章中心共 trailing 竖轴，并输出实际读数', async () => {
    const geometry = await readGeometry(page);
    console.info('[archive-axis trailing]', JSON.stringify({
      unreadCenterX: geometry.unreadCenterX,
      badgeCenterX: geometry.badgeCenterX,
      archiveRight: geometry.archiveRight,
      archiveMinusUnreadPx: geometry.archiveMinusUnreadPx,
      archiveMinusBadgePx: geometry.archiveMinusBadgePx,
    }));

    expect(geometry.archiveMinusUnreadPx).toBeCloseTo(0, 2);
    expect(geometry.archiveMinusBadgePx).toBeCloseTo(0, 2);
  });

  it('保留 hover 压层且不带 Tailwind v4 死 class', () => {
    const html = renderRow('row-static');
    expect(html).toContain('z-10');
    expect(html).not.toContain('!p-1');
  });
});

async function readGeometry(page: Page): Promise<AxisGeometry> {
  return page.evaluate(`(() => {
    const rect = (element) => {
      if (!element) throw new Error('archive alignment fixture element missing');
      return element.getBoundingClientRect();
    };
    const unreadRow = document.querySelector('[data-session-id="row-unread"]');
    const unread = [...unreadRow.querySelectorAll('span')].find((element) =>
      element.classList.contains('w-1.5') && element.classList.contains('rounded-full'));
    const badge = document.querySelector('[data-session-id="row-badge"] [data-testid="session-live-voice-badge"]');
    const archiveRow = document.querySelector('[data-session-id="row-archive"]');
    const archiveButton = archiveRow.querySelector('button');
    const unreadRect = rect(unread);
    const badgeRect = rect(badge);
    const archiveRect = rect(archiveButton);
    const rowRect = rect(archiveRow);
    const centerX = (value) => value.left + value.width / 2;
    const centerY = (value) => value.top + value.height / 2;
    return {
      rowCenterY: centerY(rowRect),
      archiveCenterY: centerY(archiveRect),
      verticalOffsetPx: centerY(archiveRect) - centerY(rowRect),
      unreadCenterX: centerX(unreadRect),
      badgeCenterX: centerX(badgeRect),
      archiveRight: archiveRect.right,
      archiveMinusUnreadPx: archiveRect.right - centerX(unreadRect),
      archiveMinusBadgePx: archiveRect.right - centerX(badgeRect),
    };
  })()`);
}
