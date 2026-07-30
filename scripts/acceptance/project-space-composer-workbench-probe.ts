#!/usr/bin/env npx tsx
// ============================================================================
// 批P 第四波返工 ④ headless 探针：空间 composer 发起的新会话 vs 主界面新会话，
// 对照右栏 workbench 落地态。生产构建不挂 window.__neoAppStore（DEV only），
// 状态一律从 DOM 读：
//   - titlebar-expand-workbench 在 ⇔ workbenchCollapsed=true（右栏整栏不渲染）
//   - titlebar-collapse-workbench 在 ⇔ 右栏展开；空 tabs 时内容=空态 launcher
// 前置条件两条路对齐：先点展开钮把右栏置于「展开 + 空 tabs（launcher）」——
// 模拟上一会话把右栏带出来过的真实现场（collapsed=false 跨会话残留）。
//
// 用法：
//   npx tsx scripts/acceptance/project-space-composer-workbench-probe.ts \
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

interface WbSample {
  collapsed: boolean | null;
  launcherVisible: boolean;
  tabStripVisible: boolean;
  tabLabels: string[];
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

  const sampleWorkbench = async (): Promise<WbSample> => page.evaluate(`(() => {
    const expandBtn = document.querySelector('[data-testid="titlebar-expand-workbench"]');
    const collapseBtn = document.querySelector('[data-testid="titlebar-collapse-workbench"]');
    const strip = document.querySelector('[data-testid="workbench-view-selector"]');
    return {
      collapsed: expandBtn ? true : collapseBtn ? false : null,
      launcherVisible: !!document.querySelector('[data-testid="workbench-empty-launcher"]'),
      tabStripVisible: !!strip,
      tabLabels: strip
        ? [...strip.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim() ?? '')
        : [],
    };
  })()`) as Promise<WbSample>;

  // 前置条件：右栏展开（收起则点展开钮）。返回前置采样。
  const setExpandedPrecondition = async (): Promise<WbSample> => {
    if (await page.$('[data-testid="titlebar-expand-workbench"]')) {
      await domClick('[data-testid="titlebar-expand-workbench"]');
      await page.waitForSelector('[data-testid="titlebar-collapse-workbench"]', { timeout: 10_000 });
    }
    await delay(300);
    return sampleWorkbench();
  };

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sidebar-new-task"]', { timeout: 60_000 });
    // 新 server 实例启动目录未信任会弹信任框——放行
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

    // ---- 路径 A：主界面「新任务」 ----
    const aPre = await setExpandedPrecondition();
    report.pathA = { precondition: aPre };
    await domClick('[data-testid="sidebar-new-task"]');
    await delay(1_500);
    (report.pathA as Record<string, unknown>).landing = await sampleWorkbench();
    await page.screenshot({ path: path.join(out, `04a-mainui-newchat-${tag}.png`) });

    // ---- 数据准备：带工作目录的协作空间 ----
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
      space = await projectApi<SpaceRow>('createSpace', { name: '探针空间④', workspacePath: process.cwd() });
    }
    report.space = { id: space.id, name: space.name };

    // ---- 路径 B：空间 composer 发起新会话 ----
    const bPre = await setExpandedPrecondition();
    report.pathB = { precondition: bPre };
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', { timeout: 30_000 });

    const probeText = `探针④${Date.now() % 100000}：请只回复 ok`;
    await page.fill('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', probeText);
    await page.press('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', 'Enter');

    // 落地采样：空间页消失（切进会话）立刻采一次，再 150ms 粒度追采 4s 时间线
    await page.waitForFunction(
      `!document.querySelector('[data-testid="project-space-page"]')`,
      { timeout: 15_000 },
    ).catch(() => undefined);
    (report.pathB as Record<string, unknown>).landingImmediate = await sampleWorkbench();
    await page.screenshot({ path: path.join(out, `04b-composer-landing-${tag}.png`) });
    const timeline: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4_000) {
      const s = await sampleWorkbench();
      timeline.push({ atMs: Date.now() - t0, ...s });
      await delay(150);
    }
    (report.pathB as Record<string, unknown>).timeline = timeline;
    (report.pathB as Record<string, unknown>).landingSettled = timeline[timeline.length - 1] ?? null;
    await page.screenshot({ path: path.join(out, `04b-composer-settled-${tag}.png`) });

    // 对照结论
    const a = (report.pathA as Record<string, unknown>).landing as WbSample;
    const b = ((report.pathB as Record<string, unknown>).landingSettled
      ?? (report.pathB as Record<string, unknown>).landingImmediate) as WbSample;
    report.verdict = {
      sameCollapsed: a.collapsed === b.collapsed,
      pathA: { collapsed: a.collapsed, launcherVisible: a.launcherVisible, tabStripVisible: a.tabStripVisible },
      pathB: { collapsed: b.collapsed, launcherVisible: b.launcherVisible, tabStripVisible: b.tabStripVisible },
    };

    // 收尾：agent 还在跑就停掉，别烧模型
    if (await page.$('button[aria-label="停止"], button[aria-label="Stop"]')) {
      await domClick('button[aria-label="停止"], button[aria-label="Stop"]').catch(() => undefined);
    }
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
