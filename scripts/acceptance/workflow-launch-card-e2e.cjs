// ============================================================================
// workflow-launch-card-e2e —— P3b 启动审批卡 UI 实挂 + 事件链 E2E（webServer headless）
//
// 走完整生产路径：POST /api/dev/emit-workflow-launch → EventBus publish('workflow','launch:requested')
// → workflow.ipc bridge 按前缀路由 → 'workflow:launch:event' → broadcastSSE → EventSource
// → App.tsx 订阅 → workflowStore.handleLaunchEvent → WorkflowLaunchCard DOM。
//
// 前置：CODE_AGENT_E2E=1 WEB_PORT=8190 node dist/web/webServer.cjs
// 跑法：node scripts/acceptance/workflow-launch-card-e2e.cjs
// ============================================================================

const { chromium, devices } = require('playwright');
const path = require('path');

const BASE = `http://localhost:${process.env.WEB_PORT || '8190'}`;

const LAUNCH_EVENT = {
  type: 'requested',
  request: {
    id: 'wf-launch-e2e',
    status: 'pending',
    requestedAt: Date.now(),
    goal: '对比 Rust vs Go 的异步运行时调度模型并产出报告',
    phases: ['decompose', 'investigate', 'synthesize'],
    estimatedAgentCalls: 7,
    fanoutSites: 2,
    writeHint: false,
    budgetTokens: 50000,
    dimensions: {
      cost: '约 7 个子 agent 调用，token 预算硬上限 50,000（耗尽即停）',
      network: '子 agent 默认可联网（WebSearch / WebFetch）收集信息',
      contextLeak: '中间结果留在脚本内，不进主对话上下文；仅最终结果回传',
      background: '后台 worker 执行（最长 30 分钟）；子 agent 只读',
    },
  },
};

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root', { timeout: 15000 });
  await page.waitForTimeout(2500);
  // 进 ChatView（审批卡挂这）
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('div,button,a,li')).find(
      (el) => (el.textContent || '').includes('CLI Session'),
    );
    if (row) row.click();
  });
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 10000 });
  await page.waitForTimeout(1500);

  const token = await page.evaluate(() => window.__CODE_AGENT_TOKEN__);
  const resp = await page.evaluate(
    async ({ base, event, token }) => {
      const r = await fetch(`${base}/api/dev/emit-workflow-launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
      });
      return { status: r.status, body: await r.text() };
    },
    { base: BASE, event: LAUNCH_EVENT, token },
  );
  console.log('emit response:', resp.status, resp.body);
  if (resp.status !== 200) throw new Error(`dev emit failed: ${resp.status} ${resp.body}`);

  // 等审批卡渲染：标题 + goal + 阶段 + 按钮。
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes('确认启动 workflow') && t.includes('开始执行') && t.includes('decompose');
    },
    { timeout: 10000 },
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  const checks = {
    title: bodyText.includes('确认启动 workflow'),
    goal: bodyText.includes('Rust vs Go'),
    phaseDecompose: bodyText.includes('decompose'),
    phaseSynthesize: bodyText.includes('synthesize'),
    agentCount: bodyText.includes('7'),
    costDim: bodyText.includes('50,000') || bodyText.includes('费用'),
    networkDim: bodyText.includes('网络'),
    contextDim: bodyText.includes('上下文'),
    backgroundDim: bodyText.includes('后台'),
    approveBtn: bodyText.includes('开始执行'),
    rejectBtn: bodyText.includes('取消'),
  };
  console.log('DOM checks:', JSON.stringify(checks, null, 2));

  await page.screenshot({ path: '/tmp/wf-launch-desktop.png', fullPage: false });
  console.log('saved /tmp/wf-launch-desktop.png');

  const iPhone = devices['iPhone 13'];
  await page.setViewportSize(iPhone.viewport);
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/wf-launch-mobile.png', fullPage: false });
  console.log('saved /tmp/wf-launch-mobile.png');

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
