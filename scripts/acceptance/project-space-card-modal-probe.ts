#!/usr/bin/env npx tsx
// ============================================================================
// 批P 第四波返工 ① headless 探针（弹窗半）：四卡「添加」弹窗——
// 搜索框（名称+描述过滤）+ 两行列表项（名称+描述，空描述单行降级）+ 图标。
// 量测/截图对象：专家卡弹窗、连接器卡弹窗（货架飞书带描述）、搜索过滤。
//
// 用法：
//   npx tsx scripts/acceptance/project-space-card-modal-probe.ts \
//     --base http://127.0.0.1:18186 --out /tmp/p4-probe [--tag after]
// ============================================================================

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const base = (argValue('--base') ?? 'http://127.0.0.1:18186').replace(/\/$/, '');
  const out = argValue('--out') ?? '/tmp/p4-probe';
  const tag = argValue('--tag') ?? 'run';
  await mkdir(out, { recursive: true });

  const pw = await loadPlaywrightChromium();
  if (!pw.ok || !pw.chromium) throw new Error(`playwright 不可用: ${pw.error ?? 'unknown'}`);
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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
    await page.waitForSelector('[data-testid="sidebar-capability-projects"]', { timeout: 60_000 });
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
      space = await projectApi<SpaceRow>('createSpace', { name: '探针空间①', workspacePath: process.cwd() });
    }

    await delay(2_000);
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-card-experts"]', { timeout: 30_000 });
    if (await page.$('[data-testid="project-space-config-rail-expand"]')) {
      await domClick('[data-testid="project-space-config-rail-expand"]');
      await page.waitForSelector('[data-testid="project-space-config-rail-collapse"]', { timeout: 10_000 });
    }

    // ---- 四卡渲染总览 ----
    const cards = await page.evaluate(`['experts','skills','connectors','automation'].map(
      (k) => !!document.querySelector('[data-testid="project-space-card-' + k + '"]')
    )`) as boolean[];
    report.fourCards = { experts: cards[0], skills: cards[1], connectors: cards[2], automation: cards[3] };

    // ---- 专家卡：整卡可点开弹窗 ----
    await domClick('[data-testid="project-space-card-experts"]');
    await page.waitForSelector('[data-testid="project-space-card-experts-picker"]', { timeout: 10_000 });
    const expertsModal = await page.evaluate(`(() => {
      const picker = document.querySelector('[data-testid="project-space-card-experts-picker"]');
      const options = [...document.querySelectorAll('[data-testid^="project-space-card-experts-option-"]')];
      return {
        searchVisible: !!document.querySelector('[data-testid="project-space-card-experts-search"]'),
        optionCount: options.length,
        // 两行项：名称行 + 描述行（两个 span）；单行降级 = 仅名称
        twoLineCount: options.filter((el) => el.querySelectorAll('span.block').length >= 2).length,
        iconCount: options.filter((el) => el.querySelector('svg')).length,
        firstOptionText: options[0]?.textContent ?? null,
      };
    })()`);
    report.expertsModal = expertsModal;
    await page.screenshot({ path: path.join(out, `01-modal-experts-${tag}.png`) });

    // 搜索过滤：输入一个长不可能命中的词 → no-match 提示
    await page.fill('[data-testid="project-space-card-experts-search"]', '绝不可能命中的词xyzzy');
    await delay(300);
    report.expertsSearchNoMatch = await page.evaluate(
      `!!document.querySelector('[data-testid="project-space-card-experts-picker-no-match"]')`,
    );
    await page.screenshot({ path: path.join(out, `01-modal-experts-search-${tag}.png`) });
    await page.keyboard.press('Escape');
    await delay(300);

    // ---- 连接器卡：弹窗里货架飞书带描述（两行项） ----
    await domClick('[data-testid="project-space-card-connectors-add"]');
    await page.waitForSelector('[data-testid="project-space-card-connectors-picker"]', { timeout: 10_000 });
    // 货架目录异步合并，等 lark 选项出现（内置货架兜底必含）
    await page.waitForSelector('[data-testid="project-space-card-connectors-option-lark"]', { timeout: 15_000 })
      .catch(() => undefined);
    const connectorsModal = await page.evaluate(`(() => {
      const options = [...document.querySelectorAll('[data-testid^="project-space-card-connectors-option-"]')];
      const lark = document.querySelector('[data-testid="project-space-card-connectors-option-lark"]');
      return {
        optionCount: options.length,
        larkPresent: !!lark,
        larkText: lark?.textContent ?? null,
        // 描述行存在 = 两个 block span
        larkTwoLine: lark ? lark.querySelectorAll('span.block').length >= 2 : false,
        twoLineCount: options.filter((el) => el.querySelectorAll('span.block').length >= 2).length,
      };
    })()`);
    report.connectorsModal = connectorsModal;
    await page.screenshot({ path: path.join(out, `01-modal-connectors-${tag}.png`) });
    await page.keyboard.press('Escape');
  } finally {
    await writeFile(path.join(out, `report-01-${tag}.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('探针异常：', error);
  process.exit(1);
});
