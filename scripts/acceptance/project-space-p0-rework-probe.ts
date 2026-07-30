#!/usr/bin/env npx tsx
// ============================================================================
// 批P 审美关返工 ①②③ headless 探针（2026-07-30 工单）
//   ① 右栏收起按钮 vs 卡片「+」右缘对齐量测
//   ② 侧栏收起态 TitleBar 展开按钮 vs 页头返回按钮左缘对齐量测
//   ③ 底部输入框发送后的落地态（用户消息在时间线上 / 进行中态，还是会话空态）
//
// 用法：
//   npx tsx scripts/acceptance/project-space-p0-rework-probe.ts \
//     --base http://127.0.0.1:18181 --out /tmp/p0-probe [--tag before]
//
// 产物：<out>/report-<tag>.json + 01/02/03 截图。量测一律在真实渲染态取
// getBoundingClientRect，不对着代码猜 padding。
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
  const base = (argValue('--base') ?? 'http://127.0.0.1:18181').replace(/\/$/, '');
  const out = argValue('--out') ?? '/tmp/p0-rework-probe';
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

  // 侧栏入口等行内有悬浮层/拖拽区，Playwright 物理点击会被拦，一律走 DOM click
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
    await delay(2_500); // 等 app 水合稳定，入口点击才不丢
    await domClick('[data-testid="sidebar-capability-projects"]');
    await page.waitForSelector('[data-testid="project-space-page"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="project-space-list-item-${space.id}"]`, { state: 'attached', timeout: 30_000 });
    await domClick(`[data-testid="project-space-list-item-${space.id}"]`);
    await page.waitForSelector('[data-testid="project-space-card-experts"]', { timeout: 30_000 });
    // 右栏收起态则先展开（localStorage 记忆）
    if (await page.$('[data-testid="project-space-config-rail-expand"]')) {
      await domClick('[data-testid="project-space-config-rail-expand"]');
      await page.waitForSelector('[data-testid="project-space-config-rail-collapse"]', { timeout: 10_000 });
    }

    // ---- ① 右栏收起按钮 vs 卡片「+」右缘 ----
    const railMeasure = await page.evaluate(`(() => {
function __rect(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
}
      return {
        collapseButton: __rect('[data-testid="project-space-config-rail-collapse"]'),
        addExperts: __rect('[data-testid="project-space-card-experts-add"]'),
        addSkills: __rect('[data-testid="project-space-card-skills-add"]'),
        addConnectors: __rect('[data-testid="project-space-card-connectors-add"]'),
        addAutomation: __rect('[data-testid="project-space-card-automation-add"]'),
      };
    })()`);
    report.railAlignment = {
      ...railMeasure,
      rightEdgeDelta: railMeasure.collapseButton && railMeasure.addExperts
        ? railMeasure.collapseButton.right - railMeasure.addExperts.right
        : null,
    };
    await page.screenshot({ path: path.join(out, `01-rail-alignment-${tag}.png`) });

    // ---- ② 侧栏收起态：TitleBar 展开按钮 vs 页头返回按钮左缘 ----
    await domClick('[data-testid="sidebar-collapse"]');
    await page.waitForSelector('[data-testid="titlebar-expand-sidebar"]', { timeout: 10_000 });
    const titlebarMeasure = await page.evaluate(`(() => {
function __rect(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
}
      return {
        expandSidebar: __rect('[data-testid="titlebar-expand-sidebar"]'),
        pageBack: __rect('[data-testid="full-screen-page-back"]'),
        platform: navigator.platform,
      };
    })()`);
    report.titlebarBackAlignment = {
      ...titlebarMeasure,
      leftEdgeDelta: titlebarMeasure.expandSidebar && titlebarMeasure.pageBack
        ? titlebarMeasure.expandSidebar.left - titlebarMeasure.pageBack.left
        : null,
    };
    await page.screenshot({ path: path.join(out, `02-titlebar-back-alignment-${tag}.png`) });

    // ---- ③ 发送落地态：回展开侧栏（页面还在），composer 发一条探针消息 ----
    // ③返工后 composer = 完整 ChatInput（textarea testid=chat-composer-textarea）
    await domClick('[data-testid="titlebar-expand-sidebar"]');
    await page.waitForSelector('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', { timeout: 10_000 });
    const probeText = `探针消息${Date.now() % 100000}：请只回复 ok`;
    const probeTextJson = JSON.stringify(probeText);
    await page.fill('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', probeText);
    await page.screenshot({ path: path.join(out, `03-before-send-${tag}.png`) });
    await page.press('[data-testid="project-space-composer"] [data-testid="chat-composer-textarea"]', 'Enter');

    const samples: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    let earlyShot = false;
    while (Date.now() - t0 < 15_000) {
      // userMsgVisible 限定在侧栏（w-60）右侧的内容区，排除侧栏会话标题的同名文本；
      // textarea 的 value 不进 innerText，但为保险排除一切 form 控件内文本
      const sample = await page.evaluate(`(() => {
        const text = ${probeTextJson};
        let userMsgVisible = false;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if (node.nodeValue && node.nodeValue.includes(text)) {
            const el = node.parentElement;
            if (el && !el.closest('textarea, input, [data-testid="project-space-page"]')
                && el.getBoundingClientRect().left > 240) {
              userMsgVisible = true;
              break;
            }
          }
          node = walker.nextNode();
        }
        return {
          composerGone: !document.querySelector('[data-testid="project-space-composer"]'),
          spacePageGone: !document.querySelector('[data-testid="project-space-page"]'),
          userMsgVisible,
          welcomeVisible: !!document.querySelector('[data-testid="welcome-directory-chip"]'),
          stopVisible: !!document.querySelector('button[aria-label="停止"], button[aria-label="Stop"]'),
        };
      })()`).catch(() => null);
      if (sample) samples.push({ atMs: Date.now() - t0, ...sample });
      if (!earlyShot && Date.now() - t0 > 1_500) {
        await page.screenshot({ path: path.join(out, `03-after-send-early-${tag}.png`) });
        earlyShot = true;
      }
      const last = samples[samples.length - 1];
      if (last && last.userMsgVisible && last.stopVisible) break;
      await delay(200);
    }
    await page.screenshot({ path: path.join(out, `03-after-send-late-${tag}.png`) });
    const final = samples[samples.length - 1] ?? null;
    // 「切进会话那一刻」= spacePageGone 首次为真的那个采样点
    const landing = samples.find((s) => s.spacePageGone) ?? null;
    report.sendLanding = {
      probeText,
      final,
      landing,
      userMsgVisibleAtLanding: landing?.userMsgVisible ?? null,
      stopVisibleAtLanding: landing?.stopVisible ?? null,
      welcomeVisibleAtLanding: landing?.welcomeVisible ?? null,
      landedAtMs: landing?.atMs ?? null,
      firstUserMsgVisibleMs: samples.find((s) => s.userMsgVisible)?.atMs ?? null,
      firstStopVisibleMs: samples.find((s) => s.stopVisible)?.atMs ?? null,
      sampleCount: samples.length,
    };

    // 收尾：若 agent 还在跑就停掉，别烧模型
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
