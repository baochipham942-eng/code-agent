#!/usr/bin/env npx tsx
// ============================================================================
// 批P 返工第二波「右栏 tab 化」headless 探针（2026-07-30 工单）
//   ① 空间右栏：tab 条贴顶、内容区全高（前后高度数值对比）、五 tab 切换、收起/展开
//   ② 正常会话 workbench tab 全交互回归：＋弹层 / tab 切换 / 关闭 / 顶栏收起展开
//   ③ 窄窗（760px）tab 条横滑不撑宽：tablist 自身滚、页面不出横向滚动条
//
// 探针对施工前后两种右栏形态都兼容（before=卡片堆叠，after=tab 壳），
// 量测一律在真实渲染态取 getBoundingClientRect，不对着代码猜尺寸。
//
// 用法：
//   npx tsx scripts/acceptance/project-space-rail-tabs-probe.ts \
//     --base http://127.0.0.1:18182 --out /tmp/p0-rail-tabs-probe --tag before
// ============================================================================

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const MEASURE_FN = `
function __rect(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}
function __metrics(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}
`;

async function main(): Promise<void> {
  const base = (argValue('--base') ?? 'http://127.0.0.1:18182').replace(/\/$/, '');
  const out = argValue('--out') ?? '/tmp/p0-rail-tabs-probe';
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

  // 行内悬浮层/拖拽区会拦 Playwright 物理点击，一律走 DOM click
  const domClick = async (selector: string): Promise<void> => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error(`domClick: ${sel} 不存在`);
      el.click();
    }, selector);
  };
  const exists = (selector: string) => page.$(selector).then((el) => el !== null);

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sidebar-capability-projects"]', { timeout: 60_000 });
    // 新 server 实例启动目录未信任会弹信任框——点「信任并加载」放行
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
    const token = await page.evaluate(() => (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__ ?? '');

    // ---- 数据准备：找一个带工作目录的协作空间，没有就建一个 ----
    const projectApi = async <T = unknown>(action: string, payload?: unknown): Promise<T> => {
      const response = await fetch(`${base}/api/domain/project/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ payload }),
      });
      const json = (await response.json()) as { success?: boolean; data?: T; error?: unknown };
      if (!json.success) throw new Error(`project/${action} failed: ${JSON.stringify(json.error)}`);
      return json.data as T;
    };
    interface SpaceRow { id: string; name: string; workspacePath?: string | null }
    const spaces = await projectApi<SpaceRow[]>('listWithActivity', { includeArchived: false, spacesOnly: true });
    let space = spaces.find((item) => item.workspacePath);
    if (!space) {
      space = await projectApi<SpaceRow>('createSpace', { name: '探针空间', workspacePath: process.cwd() });
    }
    report.space = { id: space.id, name: space.name, workspacePath: space.workspacePath };

    // ---- 进入空间视图 ----
    await delay(2_500);
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-config-rail"], [data-testid="project-space-config-rail-collapsed"]', { timeout: 30_000 });
    if (await exists('[data-testid="project-space-config-rail-expand"]')) {
      await domClick('[data-testid="project-space-config-rail-expand"]');
      await page.waitForSelector('[data-testid="project-space-config-rail-collapse"]', { timeout: 10_000 });
    }
    // 等四域数据加载（专家 chip 出现或空态文案出现都算稳定）
    await delay(1_500);

    // ---- ① 右栏结构量测（宽窗 1440） ----
    const railWide = await page.evaluate(`(() => {
      ${MEASURE_FN}
      // after：tab 壳；before：卡片堆叠。两套选择器都量，谁存在谁有数。
      const tabs = Array.from(document.querySelectorAll('[data-testid^="project-space-rail-tab-"]'))
        .map((el) => ({ testId: el.getAttribute('data-testid'), selected: el.getAttribute('aria-selected') }));
      const contentEl = document.querySelector('[data-testid="project-space-config-rail-content"]')
        ?? document.querySelector('[data-testid="project-space-config-rail"] > div:last-child');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rail: __rect('[data-testid="project-space-config-rail"]'),
        tabStrip: __rect('[data-testid="project-space-config-rail-tabs"]'),
        headerRow: __rect('[data-testid="project-space-config-rail"] > div:first-child'),
        content: contentEl ? __metrics(contentEl) : null,
        tabs,
        expertsRegion: __rect('[data-testid="project-space-rail-experts"]') ?? __rect('[data-testid="project-space-card-experts"]'),
        expertsPickerList: __rect('[data-testid="project-space-rail-experts-options"]'),
      };
    })()`);
    report.railWide = railWide;
    await page.screenshot({ path: path.join(out, `01-rail-wide-${tag}.png`) });

    // ---- ①b tab 切换 + 收起/展开（after 形态才有 tab） ----
    const tabKeys = ['experts', 'skills', 'connectors', 'automation', 'members'];
    const tabSwitch: Record<string, unknown> = { available: [] };
    for (const key of tabKeys) {
      const tabSel = `[data-testid="project-space-rail-tab-${key}"]`;
      if (!(await exists(tabSel))) continue;
      (tabSwitch.available as string[]).push(key);
      await domClick(tabSel);
      await delay(200);
      const panelVisible = await page.evaluate(`(() => {
        const panel = document.querySelector('[data-testid="project-space-rail-${key}"]');
        if (!panel) return false;
        const r = panel.getBoundingClientRect();
        return r.height > 0 && r.width > 0;
      })()`);
      (tabSwitch as Record<string, unknown>)[key] = panelVisible;
    }
    // 收起钮在 tab 条右端：量它与 tab 条的垂直对中（两态不换位置）
    if (await exists('[data-testid="project-space-config-rail-collapse"]')) {
      const collapseMeasure = await page.evaluate(`(() => {
        ${MEASURE_FN}
        return {
          collapse: __rect('[data-testid="project-space-config-rail-collapse"]'),
          strip: __rect('[data-testid="project-space-config-rail-tabs"]'),
        };
      })()`);
      tabSwitch.collapseButton = collapseMeasure;
      await domClick('[data-testid="project-space-config-rail-collapse"]');
      await page.waitForSelector('[data-testid="project-space-config-rail-collapsed"]', { timeout: 10_000 });
      const collapsedMeasure = await page.evaluate(`(() => {
        ${MEASURE_FN}
        return {
          rail: __rect('[data-testid="project-space-config-rail-collapsed"]'),
          expand: __rect('[data-testid="project-space-config-rail-expand"]'),
        };
      })()`);
      tabSwitch.collapsed = collapsedMeasure;
      await page.screenshot({ path: path.join(out, `02-rail-collapsed-${tag}.png`) });
      await domClick('[data-testid="project-space-config-rail-expand"]');
      await page.waitForSelector('[data-testid="project-space-config-rail-collapse"]', { timeout: 10_000 });
      tabSwitch.reexpanded = true;
    }
    report.tabSwitch = tabSwitch;

    // ---- ③ 窄窗 760px：tab 条横滑不撑宽 ----
    await page.setViewportSize({ width: 760, height: 900 });
    await delay(400);
    const narrow = await page.evaluate(`(() => {
      ${MEASURE_FN}
      const strip = document.querySelector('[data-testid="project-space-config-rail-tabs"] [role="tablist"]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rail: __rect('[data-testid="project-space-config-rail"]'),
        tabStripMetrics: strip ? __metrics(strip) : null,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        pageHorizOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    report.railNarrow = narrow;
    await page.screenshot({ path: path.join(out, `03-rail-narrow-${tag}.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(400);

    // ---- ② 正常会话 workbench tab 全交互回归 ----
    const wb: Record<string, unknown> = {};
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sidebar-capability-projects"]', { timeout: 60_000 });
    await delay(2_000);
    // 右栏收起态则先展开（顶栏两态同位开关）
    if (await exists('[data-testid="titlebar-expand-workbench"]')) {
      await domClick('[data-testid="titlebar-expand-workbench"]');
      await delay(500);
    }
    wb.selectorVisibleInitially = await exists('[data-testid="workbench-view-selector"]');
    // 空态（无任何已开视图）：先开「概览」让 tab 条出来
    if (!wb.selectorVisibleInitially && await exists('[data-testid="open-workbench-view-overview"]')) {
      await domClick('[data-testid="open-workbench-view-overview"]');
      await delay(400);
    }
    wb.selectorVisible = await exists('[data-testid="workbench-view-selector"]');

    if (wb.selectorVisible) {
      // ＋弹层：打开 → 出现菜单 → 开「文件」视图
      const addBtn = await page.$('[data-testid="workbench-view-selector"] button[aria-haspopup="true"]');
      wb.addButtonPresent = addBtn !== null;
      if (addBtn) {
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid="workbench-view-selector"] button[aria-haspopup="true"]');
          if (el instanceof HTMLElement) el.click();
        });
        await page.waitForSelector('[data-testid="workbench-view-menu"]', { timeout: 5_000 });
        wb.menuOpened = true;
        await page.screenshot({ path: path.join(out, `04-workbench-menu-${tag}.png`) });
        const filesEntry = await page.$('[data-testid="workbench-view-menu"] [data-testid="open-workbench-view-files"]');
        if (filesEntry) {
          await domClick('[data-testid="workbench-view-menu"] [data-testid="open-workbench-view-files"]');
          await page.waitForSelector('[data-testid="workbench-tab-files"]', { timeout: 5_000 });
          wb.filesTabOpened = true;
        } else {
          // 文件视图已在 tab 集合里（＋菜单不列已开视图）——关掉弹层直接量
          wb.filesTabOpened = await exists('[data-testid="workbench-tab-files"]');
          await page.keyboard.press('Escape');
        }
        wb.menuClosedAfterPick = !(await exists('[data-testid="workbench-view-menu"]'));
      }

      // tab 切换：files ↔ overview（aria-selected 真实翻转）
      const switchProbe = await page.evaluate(`(() => {
        const pick = (id) => document.querySelector('[data-testid="workbench-tab-' + id + '"]');
        const result = { before: null, afterFiles: null, afterOverview: null };
        const overview = pick('overview');
        const files = pick('files');
        if (overview) { result.before = overview.getAttribute('aria-selected'); }
        if (files instanceof HTMLElement) {
          files.click();
          result.afterFiles = pick('files')?.getAttribute('aria-selected') ?? null;
        }
        if (overview instanceof HTMLElement) {
          overview.click();
          result.afterOverview = pick('overview')?.getAttribute('aria-selected') ?? null;
        }
        return result;
      })()`);
      wb.tabSwitching = switchProbe;

      // 关闭 tab：files 的 ×（脏预览确认不在本探针范围，单测已覆盖）
      if (await exists('[data-testid="workbench-tab-files"]')) {
        await page.evaluate(() => {
          const tab = document.querySelector('[data-testid="workbench-tab-files"]');
          const btn = tab?.querySelector('button[aria-label]');
          if (btn instanceof HTMLElement) btn.click();
        });
        await delay(300);
        wb.filesTabClosed = !(await exists('[data-testid="workbench-tab-files"]'));
      }

      // 顶栏收起/展开（两态同位）
      if (await exists('[data-testid="titlebar-collapse-workbench"]')) {
        await domClick('[data-testid="titlebar-collapse-workbench"]');
        await delay(400);
        wb.collapsedHidesPanel = !(await exists('[data-testid="workbench-view-selector"]'));
        await page.screenshot({ path: path.join(out, `05-workbench-collapsed-${tag}.png`) });
        await domClick('[data-testid="titlebar-expand-workbench"]');
        await delay(400);
        wb.expandedRestoresPanel = await exists('[data-testid="workbench-view-selector"]');
      }
      // 终态截图（tab 条 + 内容区）
      const wbLayout = await page.evaluate(`(() => {
        ${MEASURE_FN}
        const strip = document.querySelector('[data-testid="workbench-view-selector"] [role="tablist"]');
        return {
          strip: __rect('[data-testid="workbench-view-selector"]'),
          tabStripMetrics: strip ? __metrics(strip) : null,
        };
      })()`);
      wb.layout = wbLayout;
      await page.screenshot({ path: path.join(out, `06-workbench-final-${tag}.png`) });
    }
    report.workbench = wb;
  } finally {
    await writeFile(path.join(out, `report-${tag}.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('探针异常：', error);
  process.exit(1);
});
