#!/usr/bin/env npx tsx
// ============================================================================
// 批P 第六波 ②③ headless 探针（2026-07-30 工单）：添加弹窗精致化 + 专家行模板
//   ② 添加弹窗：Modal 宽度（size 档位）、搜索输入 computed 样式（高度/字号/底色/图标）、
//      遮罩点击可关闭验证
//   ③ 专家行模板：逐行量测（图标槽是否渲染、行高、单行/两行结构）、花名·职能文案、
//      已选 chips 文案
//
// 用法：
//   npx tsx scripts/acceptance/project-space-p6-ui-probe.ts \
//     --base http://127.0.0.1:18186 --out /tmp/p6-probe [--tag before|after]
//
// 产物：<out>/report-ui-<tag>.json + 截图。18181 是产品负责人验证实例，禁动；
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
  const out = argValue('--out') ?? '/tmp/p6-probe';
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
    // 新实例启动目录未信任会弹信任框——点「信任并加载」放行，别让它盖住量测
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
    await delay(2_000);

    // ---- 进空间页（复用第五波路径：API 找/建带 workspacePath 的空间）----
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
      space = await projectApi<SpaceRow>('createSpace', { name: '探针空间⑥', workspacePath: process.cwd() });
    }
    report.space = { id: space.id, name: space.name };
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-tab-activity"]', { timeout: 30_000 });
    await delay(800);

    // 配置右栏收起则展开
    if (await page.$('[data-testid="project-space-config-rail-expand"]')) {
      await domClick('[data-testid="project-space-config-rail-expand"]');
      await page.waitForSelector('[data-testid="project-space-config-rail"]', { timeout: 10_000 });
      await delay(400);
    }

    // ---- 打开专家卡「添加」弹窗 ----
    await domClick('[data-testid="project-space-card-experts-add"]');
    await page.waitForSelector('[data-testid="project-space-card-experts-picker"]', { timeout: 10_000 });
    await delay(400);

    const modalMetrics = await page.evaluate(`(() => {
      ${RECT_FN}
      const picker = document.querySelector('[data-testid="project-space-card-experts-picker"]');
      const dialog = picker ? picker.closest('[role="dialog"], .max-w-sm, .max-w-md, .max-w-lg, .max-w-xl, .max-w-4xl') : null;
      const sizeClass = dialog ? [...dialog.classList].find((c) => c.startsWith('max-w-')) ?? null : null;
      const search = document.querySelector('[data-testid="project-space-card-experts-search"]');
      const searchInput = search ? (search.tagName === 'INPUT' ? search : search.querySelector('input')) : null;
      const searchWrap = searchInput ? searchInput.parentElement : null;
      const iconSvg = searchWrap ? searchWrap.querySelector('svg') : null;
      const cs = searchInput ? getComputedStyle(searchInput) : null;
      const rows = [...document.querySelectorAll('[data-testid^="project-space-card-experts-option-"]')].map((row) => {
        const svg = row.querySelector('svg');
        const spans = [...row.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim()).filter(Boolean);
        return {
          testid: row.getAttribute('data-testid'),
          rect: __rect(row),
          hasIconSlot: !!svg,
          lineCount: spans.length,
          texts: spans.map((t) => t.slice(0, 40)),
        };
      });
      return {
        modalSizeClass: sizeClass,
        modalRect: __rect(dialog),
        search: cs ? {
          rect: __rect(searchInput),
          height: cs.height,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          paddingLeft: cs.paddingLeft,
          background: cs.backgroundColor,
          borderRadius: cs.borderRadius,
          hasEmbeddedIcon: !!iconSvg,
          placeholder: searchInput.getAttribute('placeholder'),
        } : null,
        rows,
      };
    })()`) as Record<string, unknown>;
    report.expertsModal = modalMetrics;
    await page.screenshot({ path: path.join(out, `01-experts-add-modal-${tag}.png`) });

    // 选中第一个专家 → chip 文案取证
    const firstOption = await page.$('[data-testid^="project-space-card-experts-option-"]');
    if (firstOption) {
      const firstTestid = await firstOption.getAttribute('data-testid');
      await domClick(`[data-testid="${firstTestid}"]`);
      await delay(500);
      report.selectedOption = firstTestid;
    }
    // 弹窗可能在选中后仍开着——先量 chip，再验遮罩关闭
    const chipInfo = await page.evaluate(`(() => {
      const chips = [...document.querySelectorAll('[data-testid^="project-space-card-experts-chip-"]')];
      return chips.map((c) => ({ testid: c.getAttribute('data-testid'), text: (c.textContent ?? '').trim().slice(0, 60) }));
    })()`) as unknown;
    report.expertChips = chipInfo;
    await page.screenshot({ path: path.join(out, `02-expert-chip-${tag}.png`) });

    // ---- ② 遮罩点击关闭验证（弹窗还开着时点背板）----
    const pickerStillOpen = await page.$('[data-testid="project-space-card-experts-picker"]');
    if (pickerStillOpen) {
      await page.mouse.click(40, 450); // 弹窗左侧遮罩区
      await delay(500);
      const closed = !(await page.$('[data-testid="project-space-card-experts-picker"]'));
      report.backdropClick = { attempted: true, closed };
      if (!closed) {
        // 兜底关掉，别影响后续
        await page.keyboard.press('Escape').catch(() => undefined);
        await delay(300);
      }
    } else {
      report.backdropClick = { attempted: false, reason: 'picker closed after selection' };
      // 重新打开再验
      await domClick('[data-testid="project-space-card-experts-add"]');
      await page.waitForSelector('[data-testid="project-space-card-experts-picker"]', { timeout: 10_000 });
      await delay(300);
      await page.mouse.click(40, 450);
      await delay(500);
      report.backdropClick = { attempted: true, reopened: true, closed: !(await page.$('[data-testid="project-space-card-experts-picker"]')) };
    }
    await page.screenshot({ path: path.join(out, `03-after-backdrop-click-${tag}.png`) });

    // ---- 技能卡弹窗对照（同为 ② 对象之一，量一档即可）----
    await domClick('[data-testid="project-space-card-skills-add"]');
    await page.waitForSelector('[data-testid="project-space-card-skills-picker"]', { timeout: 10_000 });
    await delay(400);
    const skillsModal = await page.evaluate(`(() => {
      ${RECT_FN}
      const picker = document.querySelector('[data-testid="project-space-card-skills-picker"]');
      const dialog = picker ? picker.closest('[role="dialog"], .max-w-sm, .max-w-md, .max-w-lg, .max-w-xl, .max-w-4xl') : null;
      return {
        modalSizeClass: dialog ? [...dialog.classList].find((c) => c.startsWith('max-w-')) ?? null : null,
        modalRect: __rect(dialog),
      };
    })()`) as Record<string, unknown>;
    report.skillsModal = skillsModal;
    await page.screenshot({ path: path.join(out, `04-skills-add-modal-${tag}.png`) });
  } finally {
    await writeFile(path.join(out, `report-ui-${tag}.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('探针异常：', error);
  process.exit(1);
});
