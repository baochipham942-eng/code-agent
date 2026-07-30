#!/usr/bin/env npx tsx
// ============================================================================
// 批P 第四波返工 ② headless 探针：正常会话右栏 workbench tab 条贴顶。
// 量测（真实渲染 getBoundingClientRect，不猜 padding）：
//   - tab 条（workbench-view-selector）top 与窗口顶的距离（贴顶 = 0）
//   - 收起/展开开关两态的纵向位置（房规：两态同位，top 差必须 ≤1px）
// 交互回归：开视图 → ＋弹层加视图 → tab 切换 → 关闭 tab → 收起 → 展开。
//
// 用法：
//   npx tsx scripts/acceptance/workbench-tabstrip-flush-probe.ts \
//     --base http://127.0.0.1:18186 --out /tmp/p4-probe [--tag before]
// ============================================================================

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const RECT_FN = `function __rect(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}`;

async function main(): Promise<void> {
  const base = (argValue('--base') ?? 'http://127.0.0.1:18186').replace(/\/$/, '');
  const out = argValue('--out') ?? '/tmp/p4-probe';
  const tag = argValue('--tag') ?? 'run';
  await mkdir(out, { recursive: true });

  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error(`playwright 不可用: ${pw.error ?? 'unknown'}`);
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console.error] ${msg.text().slice(0, 300)}`);
  });

  const report: Record<string, unknown> = { base, tag, startedAt: new Date().toISOString() };
  const interactions: Array<Record<string, unknown>> = [];
  report.interactions = interactions;

  const domClick = async (selector: string): Promise<void> => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error(`domClick: ${sel} 不存在`);
      el.click();
    }, selector);
  };

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sidebar-new-task"]', { timeout: 60_000 });
    const trustButton = await page.waitForSelector(
      'button:has-text("信任并加载"), button:has-text("Trust and load")',
      { timeout: 3_000 },
    ).catch(() => null);
    if (trustButton) {
      await trustButton.click();
      await page.waitForSelector(
        'button:has-text("信任并加载"), button:has-text("Trust and load")',
        { state: 'detached', timeout: 10_000 },
      ).catch(() => undefined);
    }
    await delay(2_000);

    // ---- 展开右栏（收起态先点展开钮） ----
    if (await page.$('[data-testid="titlebar-expand-workbench"]')) {
      await domClick('[data-testid="titlebar-expand-workbench"]');
      await page.waitForSelector('[data-testid="titlebar-collapse-workbench"]', { timeout: 10_000 });
    }
    // 空态 launcher → 开「文件」视图，让 tab 条出现
    await page.waitForSelector('[data-testid="open-workbench-view-files"]', { timeout: 10_000 });
    await domClick('[data-testid="open-workbench-view-files"]');
    await page.waitForSelector('[data-testid="workbench-view-selector"]', { timeout: 10_000 });
    interactions.push({ step: 'open files view', ok: true });

    // ---- 核心量测：tab 条距窗口顶 ----
    const flush = await page.evaluate(`(() => {
      ${RECT_FN}
      return {
        strip: __rect('[data-testid="workbench-view-selector"]'),
        rightPanel: __rect('[id="right-panel"]'),
        titleBar: __rect('[data-tauri-drag-region]'),
        collapseToggle: __rect('[data-testid="titlebar-collapse-workbench"]'),
      };
    })()`) as Record<string, { top: number } | null>;
    report.flushMeasure = {
      ...flush,
      stripGapToWindowTop: flush.strip?.top ?? null,
      stripVsRightPanelTopDelta: flush.strip && flush.rightPanel ? flush.strip.top - flush.rightPanel.top : null,
    };
    await page.screenshot({ path: path.join(out, `02-tabstrip-flush-${tag}.png`) });

    // ---- 交互回归 1：＋弹层加视图 ----
    await domClick('[data-testid="workbench-view-selector"] [aria-haspopup="true"]');
    await page.waitForSelector('[data-testid="workbench-view-menu"]', { timeout: 5_000 });
    await domClick('[data-testid="open-workbench-view-overview"]');
    await page.waitForSelector('[data-testid="workbench-tab-overview"]', { timeout: 5_000 });
    interactions.push({ step: 'plus menu add overview', ok: true });

    // ---- 交互回归 2：tab 切换 ----
    await domClick('[data-testid="workbench-tab-files"]');
    await delay(200);
    const filesSelected = await page.evaluate(
      `document.querySelector('[data-testid="workbench-tab-files"]')?.getAttribute('aria-selected')`,
    );
    interactions.push({ step: 'switch to files tab', ok: filesSelected === 'true', ariaSelected: filesSelected });

    // ---- 交互回归 3：关闭 overview tab ----
    await domClick('[data-testid="workbench-tab-overview"] button');
    await delay(300);
    const overviewGone = !(await page.$('[data-testid="workbench-tab-overview"]'));
    interactions.push({ step: 'close overview tab', ok: overviewGone });

    // ---- 交互回归 4+5：收起 → 展开（两态开关纵向同位量测） ----
    const toggleExpanded = await page.evaluate(`(() => {
      ${RECT_FN}
      return __rect('[data-testid="titlebar-collapse-workbench"]');
    })()`) as { top: number; left: number } | null;
    await domClick('[data-testid="titlebar-collapse-workbench"]');
    await page.waitForSelector('[data-testid="titlebar-expand-workbench"]', { timeout: 10_000 });
    const stripGoneWhenCollapsed = !(await page.$('[data-testid="workbench-view-selector"]'));
    interactions.push({ step: 'collapse workbench', ok: stripGoneWhenCollapsed });
    const toggleCollapsed = await page.evaluate(`(() => {
      ${RECT_FN}
      return __rect('[data-testid="titlebar-expand-workbench"]');
    })()`) as { top: number; left: number } | null;
    await domClick('[data-testid="titlebar-expand-workbench"]');
    await page.waitForSelector('[data-testid="workbench-view-selector"]', { timeout: 10_000 });
    interactions.push({ step: 'expand workbench (tabs restored)', ok: true });

    report.toggleTwoState = {
      expandedState: toggleExpanded,
      collapsedState: toggleCollapsed,
      // 房规：两态同位——纵向 top 差必须 ≤1px
      topDelta: toggleExpanded && toggleCollapsed ? toggleExpanded.top - toggleCollapsed.top : null,
      leftDelta: toggleExpanded && toggleCollapsed ? toggleExpanded.left - toggleCollapsed.left : null,
    };
    await page.screenshot({ path: path.join(out, `02-after-reopen-${tag}.png`) });
  } finally {
    await writeFile(path.join(out, `report-02-${tag}.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('探针异常：', error);
  process.exit(1);
});
