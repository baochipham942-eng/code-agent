#!/usr/bin/env npx tsx
// ============================================================================
// 批P 第五波 ①②③④ + 右栏回归 headless 探针（2026-07-30 工单）
//   ① 侧栏三段垂直节奏：能力区末行底→节头顶 / 节头底→组头顶 / 组头底→首行顶 /
//      节头之间（上一分区末组底→下一节头顶），逐分区量测（真实渲染 getBoundingClientRect）
//   ② 窄态对齐：逐级压窄窗口（720/560/480），侧栏宽、左轨（图标列）、右轨（元数据右缘）、
//      标题截断态逐宽量测 + 截图（先复现定性，不对代码猜）
//   ③ 非选中项目组头底色：逐组头读 computed background-color，对照栏面 zinc-950
//   ④ 空间页头底 → tab 行顶 gap
//   回归：右栏收起态切历史会话 → 右栏保持收起（第四波④修复覆盖切会话路径的证明）
//
// 用法：
//   npx tsx scripts/acceptance/sidebar-visual-p5-probe.ts \
//     --base http://127.0.0.1:18186 --out /tmp/p5-probe [--tag before]
//
// 产物：<out>/report-<tag>.json + 01~05 截图。18181 是产品负责人验证实例，禁动；
// 本探针只连 --base 指定的实例（默认 18186，自起自杀）。
// ============================================================================

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const RECT_FN = `function __rect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}`;

async function main(): Promise<void> {
  const base = (argValue('--base') ?? 'http://127.0.0.1:18186').replace(/\/$/, '');
  const out = argValue('--out') ?? '/tmp/p5-probe';
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

  // 侧栏行内有 sticky/悬浮层，物理点击会被拦，一律走 DOM click（同前四波探针约定）
  const domClick = async (selector: string): Promise<void> => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error(`domClick: ${sel} 不存在`);
      el.click();
    }, selector);
  };

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sidebar-capability-zone"]', { timeout: 60_000 });
    // 新 server 实例启动目录未信任时会弹信任框——点「信任并加载」放行，别让它盖住量测
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
    await delay(2_000); // 等会话列表水合稳定

    // ---- ① 侧栏三段垂直节奏（1440 常态）----
    const rhythm = await page.evaluate(`(() => {
      ${RECT_FN}
      const zone = document.querySelector('[data-testid="sidebar-capability-zone"]');
      const zoneLastRow = zone ? zone.children[zone.children.length - 1] : null;
      const sections = [...document.querySelectorAll('section[data-testid^="sidebar-tier-"]')];
      const perSection = sections.map((section) => {
        const header = section.firstElementChild;
        const groups = [...section.querySelectorAll('[data-sidebar-group-phase]')];
        const firstGroup = groups[0] ?? null;
        const groupHeader = firstGroup ? firstGroup.firstElementChild : null;
        const firstRow = firstGroup ? firstGroup.querySelector('[data-sidebar-group-rows] > *') : null;
        const lastGroup = groups[groups.length - 1] ?? null;
        return {
          tier: section.getAttribute('data-testid'),
          header: __rect(header),
          firstGroupHeader: __rect(groupHeader),
          firstRow: __rect(firstRow),
          lastGroupBottom: lastGroup ? lastGroup.getBoundingClientRect().bottom : null,
          groupCount: groups.length,
        };
      });
      const zoneBottom = zoneLastRow ? zoneLastRow.getBoundingClientRect().bottom : null;
      return {
        zoneLastRowBottom: zoneBottom,
        zoneLastRowTestid: zoneLastRow ? zoneLastRow.getAttribute('data-testid') : null,
        sections: perSection.map((s, i) => ({
          ...s,
          gapFromPrev: i === 0
            ? (zoneBottom != null && s.header ? s.header.top - zoneBottom : null)
            : (perSection[i - 1].lastGroupBottom != null && s.header ? s.header.top - perSection[i - 1].lastGroupBottom : null),
          gapHeaderToGroup: s.header && s.firstGroupHeader ? s.firstGroupHeader.top - s.header.bottom : null,
          gapGroupHeaderToRow: s.firstGroupHeader && s.firstRow ? s.firstRow.top - s.firstGroupHeader.bottom : null,
        })),
      };
    })()`) as unknown;
    report.rhythm1440 = rhythm;
    await page.screenshot({ path: path.join(out, `01-sidebar-rhythm-${tag}.png`) });

    // ---- ③ 组头底色（非选中组不得有常驻底色）----
    const groupBgs = await page.evaluate(`(() => {
      ${RECT_FN}
      const sidebar = document.querySelector('[data-testid="sidebar-collapse"]');
      const rail = sidebar ? sidebar.closest('.w-60') : null;
      const railBg = rail ? getComputedStyle(rail).backgroundColor : null;
      const groups = [...document.querySelectorAll('[data-sidebar-group-phase]')];
      return {
        railBg,
        groups: groups.map((g) => {
          const header = g.firstElementChild;
          const hasCurrent = !!g.querySelector('[aria-current="true"]');
          const name = header ? (header.getAttribute('title') ?? '').slice(0, 40) : null;
          return {
            name,
            hasCurrent,
            bg: header ? getComputedStyle(header).backgroundColor : null,
            classes: header ? header.className : null,
          };
        }),
      };
    })()`) as unknown;
    report.groupHeaderBg = groupBgs;

    // ---- 回归：右栏收起态切历史会话 → 右栏保持收起 ----
    const sampleRail = async (): Promise<Record<string, unknown>> => page.evaluate(`(() => {
      const expandBtn = document.querySelector('[data-testid="titlebar-expand-workbench"]');
      const collapseBtn = document.querySelector('[data-testid="titlebar-collapse-workbench"]');
      return {
        collapsed: expandBtn ? true : collapseBtn ? false : null,
        launcherVisible: !!document.querySelector('[data-testid="workbench-empty-launcher"]'),
        currentSessionTitle: (document.querySelector('[data-session-id][aria-current="true"]') ?? {}).textContent?.trim()?.slice(0, 60) ?? null,
      };
    })()`) as Promise<Record<string, unknown>>;
    // 前置：右栏收起（展开则点收起钮）
    if (await page.$('[data-testid="titlebar-collapse-workbench"]')) {
      await domClick('[data-testid="titlebar-collapse-workbench"]');
      await page.waitForSelector('[data-testid="titlebar-expand-workbench"]', { timeout: 10_000 });
    }
    const railBefore = await sampleRail();
    // 切一条非当前的历史会话
    const switched = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-session-id]')];
      const target = rows.find((row) => row.getAttribute('aria-current') !== 'true');
      if (!target) return null;
      const id = target.getAttribute('data-session-id');
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return id;
    })()`) as string | null;
    report.railRegression = { precondition: railBefore, switchedTo: switched };
    if (switched) {
      await delay(1_800);
      const railAfter = await sampleRail();
      (report.railRegression as Record<string, unknown>).afterSwitch = railAfter;
      (report.railRegression as Record<string, unknown>).stayedCollapsed = railAfter.collapsed === true;
      await page.screenshot({ path: path.join(out, `02-rail-after-session-switch-${tag}.png`) });
    }

    // ---- ② 窄态对齐：逐级压窄，定性「这是什么态」+ 逐宽量测 ----
    // 定性结论（修前复现）：窗口 <1180 侧栏自动收起（SIDEBAR_AUTO_COLLAPSE_WIDTH），
    // 手动再展开后 rail w-60 无下限——窗口 <240 时 rail 被 flex 压到窗口宽（爸截图 ~120px 即此态）。
    // 所以每档压窄后要手动点展开钮「到达被测状态」，并断言 rail 确实 <240。
    const narrowRuns: Array<Record<string, unknown>> = [];
    for (const width of [240, 200, 160]) {
      await page.setViewportSize({ width, height: 900 });
      await delay(500);
      if (await page.$('[data-testid="titlebar-expand-sidebar"]')) {
        await domClick('[data-testid="titlebar-expand-sidebar"]');
        await page.waitForSelector('[data-testid="sidebar-capability-zone"]', { timeout: 10_000 });
        await delay(400);
      }
      const m = await page.evaluate(`(() => {
        ${RECT_FN}
        const sidebar = document.querySelector('[data-testid="sidebar-collapse"]');
        const rail = sidebar ? sidebar.closest('.w-60') : null;
        const rowInfo = (row) => {
          if (!row) return null;
          const icon = row.querySelector('svg');
          const title = row.querySelector('span.truncate');
          const bits = [...row.querySelectorAll('span')].map((s) => ({
            text: (s.textContent ?? '').trim().slice(0, 24),
            rect: __rect(s),
            truncated: s.classList.contains('truncate') ? s.scrollWidth > s.clientWidth : null,
          }));
          return {
            row: __rect(row),
            iconLeft: icon ? icon.getBoundingClientRect().left : null,
            titleTruncated: title ? title.scrollWidth > title.clientWidth : null,
            titleText: title ? (title.textContent ?? '').slice(0, 30) : null,
            spans: bits,
          };
        };
        const automation = document.querySelector('[data-testid="sidebar-capability-automation"]');
        const group = document.querySelector('[data-sidebar-group-phase]');
        const groupHeader = group ? group.firstElementChild : null;
        const sessionRow = document.querySelector('[data-session-id]');
        return {
          viewportWidth: window.innerWidth,
          rail: __rect(rail),
          reachedSqueezedState: rail ? rail.getBoundingClientRect().width < 240 : false,
          automationRow: rowInfo(automation),
          groupHeader: rowInfo(groupHeader),
          sessionRow: rowInfo(sessionRow),
          horizontalScroll: rail ? rail.scrollWidth > rail.clientWidth : null,
        };
      })()`) as Record<string, unknown>;
      narrowRuns.push(m);
      await page.screenshot({ path: path.join(out, `03-narrow-${width}-${tag}.png`) });
    }
    report.narrow = narrowRuns;
    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(500);
    // 窄窗自动收起是单向的，回 1440 后侧栏仍收着——先展开再进空间页（此前探针在 ④ 扑空的原因）
    if (await page.$('[data-testid="titlebar-expand-sidebar"]')) {
      await domClick('[data-testid="titlebar-expand-sidebar"]');
      await page.waitForSelector('[data-testid="sidebar-capability-zone"]', { timeout: 10_000 });
      await delay(400);
    }

    // ---- ④准绳：能力中心「页头 ↔ 内容区」间距现值 ----
    await domClick('[data-testid="sidebar-capability-hub"]');
    await page.waitForSelector('nav[role="tablist"]', { timeout: 30_000 });
    await delay(600);
    const hubRhythm = await page.evaluate(`(() => {
      ${RECT_FN}
      const nav = [...document.querySelectorAll('header nav[role="tablist"]')][0] ?? null;
      const header = nav ? nav.closest('header') : null;
      const content = header ? header.nextElementSibling : null;
      const navRect = nav ? nav.getBoundingClientRect() : null;
      const contentRect = content ? content.getBoundingClientRect() : null;
      return {
        header: __rect(header),
        nav: __rect(nav),
        content: __rect(content),
        gapNavBottomToContentTop: navRect && contentRect ? contentRect.top - navRect.bottom : null,
      };
    })()`) as unknown;
    report.hubHeaderContentGap = hubRhythm;
    await page.screenshot({ path: path.join(out, `05-hub-header-content-${tag}.png`) });

    // ---- ④ 空间页头底 → tab 行顶 gap ----
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
    let space = spaces.find((item) => item.workspacePath) ?? spaces[0];
    if (!space) {
      space = await projectApi<SpaceRow>('createSpace', { name: '探针空间⑤', workspacePath: process.cwd() });
    }
    report.space = { id: space.id, name: space.name };
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-tab-activity"]', { timeout: 30_000 });
    await delay(600);
    const headerTabGap = await page.evaluate(`(() => {
      ${RECT_FN}
      const spacePage = document.querySelector('[data-testid="project-space-page"]');
      const header = spacePage ? spacePage.querySelector('header') : null;
      const nav = spacePage ? spacePage.querySelector('nav[role="tablist"]') : null;
      const firstTab = document.querySelector('[data-testid="project-space-tab-activity"]');
      const headerRect = header ? header.getBoundingClientRect() : null;
      const navRect = nav ? nav.getBoundingClientRect() : null;
      const firstTabRect = firstTab ? firstTab.getBoundingClientRect() : null;
      return {
        header: __rect(header),
        nav: __rect(nav),
        firstTab: __rect(firstTab),
        gapHeaderBottomToNavTop: headerRect && navRect ? navRect.top - headerRect.bottom : null,
        gapHeaderBottomToFirstTabTop: headerRect && firstTabRect ? firstTabRect.top - headerRect.bottom : null,
      };
    })()`) as unknown;
    report.spaceHeaderTabGap = headerTabGap;
    await page.screenshot({ path: path.join(out, `04-space-header-tab-${tag}.png`) });
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
