// ============================================================================
// workflow-progress-tree-e2e —— P3a 进度树 UI 实挂 + 完整事件链 E2E（webServer headless）
//
// 走完整生产路径：POST /api/dev/emit-workflow-events → EventBus publish('workflow')
// → 通用 EventBridge → webContents.send('workflow:event') → broadcastSSE → EventSource
// → httpTransport → App.tsx 订阅 → workflowStore → WorkflowInlineMonitor DOM。
// 验证 vitest 不覆盖的：真实 React mount + SSE 通道 + Tailwind 布局（desktop + mobile）。
//
// 前置：CODE_AGENT_E2E=1 WEB_PORT=8190 node dist/web/webServer.cjs
// 跑法：node scripts/acceptance/workflow-progress-tree-e2e.cjs
// ============================================================================

const { chromium, devices } = require('playwright');
const path = require('path');

const PORT = process.env.WEB_PORT || '8190';
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = '/tmp';

// 模拟 scriptRuntime 后台 run：2 phase / 3 子 agent（done + running 混合 + judge）。
const RUN = 'wf-e2e-1';
// 用真实 epoch ms（对齐生产里 ts=ctx.now()），让面板 duration 显示正常的几秒。
const T0 = Date.now() - 8000;
const EVENTS = [
  { runId: RUN, type: 'run:start', ts: T0, data: { goal: '对比 Rust vs Go 的异步运行时调度模型', scriptHash: 'e2e' } },
  { runId: RUN, type: 'run:phase', ts: T0 + 100, data: { title: 'decompose' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 200, data: { agentId: `${RUN}-a1`, label: 'split', phase: 'decompose', model: 'mimo-v2.5-pro', hasSchema: true, promptPreview: '把问题拆成 2 个可独立调研的子问题' } },
  { runId: RUN, type: 'agent:done', ts: T0 + 800, data: { agentId: `${RUN}-a1`, label: 'split', resultPreview: '{"questions":["Rust tokio 调度","Go goroutine 调度"]}' } },
  { runId: RUN, type: 'run:phase', ts: T0 + 900, data: { title: 'investigate' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 1000, data: { agentId: `${RUN}-a2`, label: 'research-rust', phase: 'investigate', model: 'mimo-v2.5-pro', promptPreview: '调研 Rust tokio 的 work-stealing 调度器' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 1050, data: { agentId: `${RUN}-a3`, label: 'research-go', phase: 'investigate', model: 'mimo-v2.5-pro', promptPreview: '调研 Go runtime 的 GMP 调度模型' } },
  { runId: RUN, type: 'agent:done', ts: T0 + 1600, data: { agentId: `${RUN}-a2`, label: 'research-rust', resultPreview: 'tokio 用 work-stealing 多线程运行时，M:N 绿色线程映射到 worker 线程池' } },
  // a3 留 running、不发 run:done → 面板保持 running 可见态
];

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // SSE 让 networkidle 永不触发；等 app 根挂载即可。
  await page.waitForSelector('#root', { timeout: 15000 });
  await page.waitForTimeout(2500); // 等 httpTransport 的 EventSource 连上 /api/events

  // WorkflowInlineMonitor 挂在 ChatView（ChatInput 之上），需先打开一个会话进对话视图。
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('div,button,a,li')).find(
      (el) => (el.textContent || '').includes('CLI Session'),
    );
    if (row) row.click();
  });
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 从已认证的页面上下文 POST（带上注入的 token），驱动真实 SSE 链路。
  const token = await page.evaluate(() => window.__CODE_AGENT_TOKEN__);
  const resp = await page.evaluate(
    async ({ base, events, token }) => {
      const r = await fetch(`${base}/api/dev/emit-workflow-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events }),
      });
      return { status: r.status, body: await r.text() };
    },
    { base: BASE, events: EVENTS, token },
  );
  console.log('emit response:', resp.status, resp.body);
  if (resp.status !== 200) throw new Error(`dev emit failed: ${resp.status} ${resp.body}`);

  // 等进度树渲染：标题 "workflow" + 子 agent label 出现（phase 头经 CSS uppercase，用小写匹配 innerText 会漏，统一 toLowerCase）。
  await page.waitForFunction(
    () => {
      const t = document.body.innerText.toLowerCase();
      return t.includes('workflow') && t.includes('research-rust') && t.includes('investigate');
    },
    { timeout: 10000 },
  );

  // 断言计数 + phase 分组 + 状态文案都在 DOM 里（toLowerCase 兼容 phase 头的 CSS uppercase）。
  const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  const checks = {
    hasWorkflow: bodyText.includes('workflow'),
    hasGoal: bodyText.includes('rust vs go'),
    hasDecompose: bodyText.includes('decompose'),
    hasInvestigate: bodyText.includes('investigate'),
    hasRunning: bodyText.includes('running'),
    hasDone: bodyText.includes('done'),
    splitLabel: bodyText.includes('split'),
    researchRust: bodyText.includes('research-rust'),
    researchGo: bodyText.includes('research-go'),
  };
  console.log('DOM checks:', JSON.stringify(checks, null, 2));

  // 截图 desktop。
  await page.screenshot({ path: path.join(OUT_DIR, 'wf-progress-desktop.png'), fullPage: false });
  console.log('saved', path.join(OUT_DIR, 'wf-progress-desktop.png'));

  // 切 mobile viewport（不 reload，保留 store 状态）截图。
  const iPhone = devices['iPhone 13'];
  await page.setViewportSize(iPhone.viewport);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'wf-progress-mobile.png'), fullPage: false });
  console.log('saved', path.join(OUT_DIR, 'wf-progress-mobile.png'));

  const allPass = Object.values(checks).every(Boolean);
  console.log('console errors:', errors.length, errors.slice(0, 5));
  console.log(allPass ? 'E2E PASS ✅' : 'E2E FAIL ❌');

  await browser.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
