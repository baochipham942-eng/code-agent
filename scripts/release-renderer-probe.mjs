#!/usr/bin/env node
// ============================================================================
// 发布前 renderer 启动冒烟探针（feedback_tauri_release_pipeline 坑#5）
//
// vitest pass ≠ 启动不崩。v0.16.89 曾在单测全过、公证成功后装机即 ErrorBoundary
// 全屏崩溃（命令重复注册），烧掉一轮 25 分钟公证才暴露。本脚本在跑
// tauri:release:bundle 之前用 playwright-core headless 加载 webServer 首页，
// 抓 console error + pageerror，确认渲染出应用主界面而不是"出错了"。
//
// 用法: node scripts/release-renderer-probe.mjs [port]
// 退出码: 0=通过, 1=渲染崩溃或加载失败
// ============================================================================

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8182);
const PROBE_TIMEOUT_MS = 60_000;

async function main() {
  console.log(`[probe] starting webServer on :${PORT} ...`);
  const server = spawn('node', ['dist/web/webServer.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, WEB_PORT: String(PORT), CODE_AGENT_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  const killServer = () => {
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  };

  try {
    // 等 webServer 就绪
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* not ready yet */ }
      await sleep(500);
    }
    if (!healthy) {
      console.error('[probe] FAIL: webServer 30s 内未就绪');
      console.error(serverOutput.slice(-2000));
      return 1;
    }
    console.log('[probe] webServer ready, launching headless browser ...');

    const { chromium } = await import('playwright-core');
    const executablePath = process.env.CHROME_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
    // 给 React 一点时间渲染/崩溃
    await sleep(8_000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const hasErrorBoundary = /出错了|Something went wrong/i.test(bodyText);
    // 应用主界面特征：会话/聊天相关文案或主容器存在
    const hasAppShell = await page.evaluate(() =>
      Boolean(document.querySelector('#root')?.children.length)
    );

    await browser.close();

    console.log(`[probe] pageerror 数: ${pageErrors.length}, console error 数: ${consoleErrors.length}`);
    console.log(`[probe] ErrorBoundary 出现: ${hasErrorBoundary}, 应用壳渲染: ${hasAppShell}`);

    if (hasErrorBoundary || pageErrors.length > 0 || !hasAppShell) {
      console.error('[probe] FAIL — renderer 启动异常');
      if (pageErrors.length) console.error('pageerrors:', pageErrors.slice(0, 5).join('\n'));
      if (consoleErrors.length) console.error('console errors:', consoleErrors.slice(0, 10).join('\n'));
      console.error('body 前 500 字:', bodyText.slice(0, 500));
      return 1;
    }

    console.log('[probe] PASS — renderer 正常启动');
    return 0;
  } finally {
    killServer();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[probe] 脚本异常:', err);
  process.exit(1);
});
