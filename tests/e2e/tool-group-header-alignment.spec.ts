// ============================================================================
// E2E: 工具组组头（ToolStepGroup）状态词与标签的真实排版对齐
//
// 背景：组头两段字都是 11px，但状态词原先继承 body 的 Inter、标签是 JetBrains Mono。
// 两个字体栈都不含中文字形，各自回退到不同的系统 CJK 字体，度量不一致 →
// 同一行里基线差 1px，中文方块字下肉眼可见（2026-08-06 用户报「这2组文字没有垂直
// 居中对齐」）。修法是统一字体栈，不是改 align-items——实测改 items-baseline 无效。
//
// 为什么必须是 e2e 而不是单测：这是**排版几何**问题，只有真实字体加载 + 真实布局
// 才量得出来。jsdom 不做布局，className 断言只能钉住"写了什么 class"，钉不住
// "渲染出来是不是齐的"。2026-08-06 就是因为只在手搭的 DOM 上量（还用错了字号），
// 把根因误判到另一个组件上。
//
// 造数据走直接落库：dev 事件接口造不出能渲进 transcript 的工具行。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, type Page } from '@playwright/test';

const require_ = createRequire(import.meta.url);

test.setTimeout(120_000);

const SESSION_ID = 'e2e-tool-group-header-align';
const DATA_DIR = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-e2e-data-${process.env.E2E_WEB_PORT || '8180'}`);

/** 塞一条带失败工具调用的 assistant 消息，让真实 ToolStepGroup 渲出组头。 */
function seedFailedToolCall(): void {
  const Database = require_('better-sqlite3');
  const dbPath = path.join(DATA_DIR, 'code-agent.db');
  expect(
    fs.existsSync(dbPath),
    `scratch 库不存在：${dbPath} —— webServer 没起来或数据目录约定变了，本用例的造数据前提失效`,
  ).toBe(true);

  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(SESSION_ID, '组头对齐验收', 'deepseek', 'deepseek-chat', now, now);

    db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results)
       VALUES (?, ?, 'assistant', '', ?, ?, ?)`,
    ).run(
      `${SESSION_ID}-msg`,
      SESSION_ID,
      now,
      JSON.stringify([{
        id: `${SESSION_ID}-tc`,
        name: 'spawn_task',
        arguments: { title: '组头对齐验收', short_name: '验收' },
      }]),
      JSON.stringify([{
        toolCallId: `${SESSION_ID}-tc`,
        success: false,
        error: '工具 "spawn_task" 参数校验失败（1 处问题）',
        duration: 1200,
      }]),
    );
  } finally {
    db.close();
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const btn = page.getByRole('button', { name });
    await btn.waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
}

test('组头状态词与标签：同一字体栈，基线严格对齐', async ({ page }, testInfo) => {
  // 先让 webServer 建好库，再塞数据，然后 reload 让侧栏看见。
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);

  seedFailedToolCall();

  await page.reload();
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);

  const item = page.locator(`[data-session-id="${SESSION_ID}"]`).first();
  await expect(item, '落库的会话没出现在侧栏 —— 造数据没生效').toBeVisible({ timeout: 20_000 });
  await item.click();

  const groupHeader = page.locator('button[aria-expanded]').filter({ hasText: '失败' }).first();
  await expect(groupHeader, '真实 ToolStepGroup 组头没渲出来').toBeVisible({ timeout: 20_000 });

  const measured = await groupHeader.evaluate((btn) => {
    const spans = Array.from(btn.querySelectorAll('span'));
    // 状态词 = 有文字且 flex-shrink-0 的那个；标签 = 带 truncate 的那个
    const statusEl = spans.find(
      (s) => s.className.includes('flex-shrink-0') && (s.textContent || '').trim().length > 0,
    );
    const labelEl = spans.find((s) => s.className.includes('truncate'));
    if (!statusEl || !labelEl) {
      return { error: `组头结构变了：status=${!!statusEl} label=${!!labelEl}` };
    }

    // 真实基线：塞一个零宽、vertical-align:baseline 的探针，读它的 top。
    const baselineOf = (n: Element): number => {
      const probe = document.createElement('span');
      probe.setAttribute('style', 'display:inline-block;width:0;height:0;vertical-align:baseline');
      n.appendChild(probe);
      const y = probe.getBoundingClientRect().top;
      probe.remove();
      return y;
    };
    const cs = (n: Element) => getComputedStyle(n as HTMLElement);
    return {
      statusText: (statusEl.textContent || '').trim(),
      labelText: (labelEl.textContent || '').trim(),
      statusFamily: cs(statusEl).fontFamily,
      labelFamily: cs(labelEl).fontFamily,
      statusSize: cs(statusEl).fontSize,
      labelSize: cs(labelEl).fontSize,
      baselineDelta: +(baselineOf(labelEl) - baselineOf(statusEl)).toFixed(3),
    };
  });

  await groupHeader.screenshot({ path: testInfo.outputPath('tool-group-header.png') });

  expect(measured.error, `定位失败：${String(measured.error)}`).toBeUndefined();

  // 前提断言：两段字必须都真的渲染出来了，否则下面的 0 偏差是无意义的假绿。
  expect(measured.statusText, '状态词为空 —— 本用例的前提不成立').toBeTruthy();
  expect(measured.labelText, '标签为空 —— 本用例的前提不成立').toBeTruthy();

  // 根因断言：字体栈必须一致。这是承重的那一条 —— 基线差为 0 是它的结果。
  expect(
    measured.labelFamily,
    `状态词字体栈(${String(measured.statusFamily)}) 与标签(${String(measured.labelFamily)}) 不一致；`
    + '两个栈的中文回退字体度量不同，会把这一行的基线错开',
  ).toBe(measured.statusFamily);

  // 结果断言：真实基线重合。
  expect(
    Math.abs(Number(measured.baselineDelta)),
    `组头「${String(measured.statusText)}」与「${String(measured.labelText)}」基线相差 `
    + `${String(measured.baselineDelta)}px`,
  ).toBeLessThan(0.01);
});
