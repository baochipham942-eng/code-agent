// ============================================================================
// workflow-resume-cached-e2e —— P4-E 进度树 cached 徽章 UI 实挂（webServer headless）
//
// 注入「resumable 重放」事件流（部分 agent 带 data.cached:true）走完整 SSE 链路，验证
// WorkflowInlineMonitor 把命中缓存的 agent 渲染成 ⚡cached 徽章（瞬时 done），且 live agent 不带。
//
// 前置：CODE_AGENT_E2E=1 WEB_PORT=8190 node dist/web/webServer.cjs
// 跑法：node scripts/acceptance/workflow-resume-cached-e2e.cjs
// ============================================================================

const { chromium, devices } = require('playwright');
const path = require('path');

const PORT = process.env.WEB_PORT || '8190';
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = '/tmp';

// 模拟一次 resume run：a1/a2 命中缓存（cached:true，瞬时 done），a3 是 live（重跑、running）。
const RUN = 'wf-resume-e2e-1';
const T0 = Date.now() - 5000;
const EVENTS = [
  { runId: RUN, type: 'run:start', ts: T0, data: { goal: '重放上次的 Rust 调研（命中缓存）', scriptHash: 'resume' } },
  { runId: RUN, type: 'run:phase', ts: T0 + 50, data: { title: 'facts' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 100, data: { agentId: `${RUN}-a1`, label: 'list-facts', phase: 'facts', model: 'mimo-v2.5-pro', hasSchema: true, cached: true, promptPreview: '列出 2 个关键事实' } },
  { runId: RUN, type: 'agent:done', ts: T0 + 100, data: { agentId: `${RUN}-a1`, label: 'list-facts', cached: true, resultPreview: '{"facts":["…","…"]}' } },
  { runId: RUN, type: 'run:phase', ts: T0 + 200, data: { title: 'summarize' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 250, data: { agentId: `${RUN}-a2`, label: 'summarize', phase: 'summarize', model: 'mimo-v2.5-pro', hasSchema: true, cached: true, promptPreview: '一句话总结' } },
  { runId: RUN, type: 'agent:done', ts: T0 + 250, data: { agentId: `${RUN}-a2`, label: 'summarize', cached: true, resultPreview: '{"summary":"…"}' } },
  // a3：编辑过的新 call，live 重跑、保持 running（无 cached 标记）→ 面板保持 running 可见
  { runId: RUN, type: 'run:phase', ts: T0 + 300, data: { title: 'extend' } },
  { runId: RUN, type: 'agent:start', ts: T0 + 350, data: { agentId: `${RUN}-a3`, label: 'deep-dive', phase: 'extend', model: 'mimo-v2.5-pro', promptPreview: '新增：深入 borrow checker' } },
];

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root', { timeout: 15000 });
  await page.waitForTimeout(2500);

  // WorkflowInlineMonitor 挂 ChatView → 先开会话进对话视图。
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

  // 等进度树 + cached 徽章渲染。
  await page.waitForFunction(
    () => {
      const t = document.body.innerText.toLowerCase();
      return t.includes('workflow') && t.includes('list-facts') && t.includes('cached');
    },
    { timeout: 10000 },
  );

  const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  // cached 徽章数：统计 DOM 里 'cached' 出现次数（a1+a2 两个命中 → 至少 2）。
  const cachedCount = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('span'));
    return nodes.filter((n) => (n.textContent || '').trim() === 'cached').length;
  });
  const checks = {
    hasWorkflow: bodyText.includes('workflow'),
    hasCachedBadge: bodyText.includes('cached'),
    twoCachedBadges: cachedCount >= 2,        // a1 + a2 命中
    cachedAgentsShown: bodyText.includes('list-facts') && bodyText.includes('summarize'),
    liveAgentShown: bodyText.includes('deep-dive'),
    running: bodyText.includes('running'),
  };
  console.log('DOM checks:', JSON.stringify(checks, null, 2), '| cached badge count:', cachedCount);

  await page.screenshot({ path: path.join(OUT_DIR, 'wf-resume-cached-desktop.png'), fullPage: false });
  console.log('saved', path.join(OUT_DIR, 'wf-resume-cached-desktop.png'));

  const iPhone = devices['iPhone 13'];
  await page.setViewportSize(iPhone.viewport);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'wf-resume-cached-mobile.png'), fullPage: false });
  console.log('saved', path.join(OUT_DIR, 'wf-resume-cached-mobile.png'));

  const allPass = Object.values(checks).every(Boolean);
  console.log('console errors:', errors.length, errors.slice(0, 5));
  console.log(allPass ? 'CACHED-BADGE E2E PASS ✅' : 'CACHED-BADGE E2E FAIL ❌');
  await browser.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
