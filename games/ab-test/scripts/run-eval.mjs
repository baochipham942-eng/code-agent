// 评测脚本: 4 项指标 (build / runtime smoke / 首屏截图 / 可玩性)
// 用法: node run-eval.mjs a1   或   node run-eval.mjs a2
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execP = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const variant = process.argv[2];
  if (!variant || !['a1', 'a2'].includes(variant)) {
    console.error('Usage: node run-eval.mjs <a1|a2>');
    process.exit(1);
  }

  const variantDir = variant === 'a1' ? path.join(ROOT, 'a1-mimo-bare') : path.join(ROOT, 'a2-mimo-opengame');
  const report = { variant, started: new Date().toISOString(), steps: {} };

  // ===== 1. build =====
  console.log(`\n[${variant.toUpperCase()}] === build ===`);
  if (variant === 'a1') {
    const htmlPath = path.join(variantDir, 'index.html');
    try {
      const html = await fs.readFile(htmlPath, 'utf8');
      // 轻量"build"检查: 是否完整 HTML / 是否包含 <canvas> 或 canvas 创建
      const hasDoctype = html.toLowerCase().includes('<!doctype html');
      const hasHtmlClose = html.toLowerCase().includes('</html>');
      const hasCanvas = /canvas/i.test(html);
      const hasScript = /<script/i.test(html);
      report.steps.build = {
        ok: hasDoctype && hasHtmlClose && hasCanvas && hasScript,
        checks: { hasDoctype, hasHtmlClose, hasCanvas, hasScript },
        bytes: html.length,
      };
    } catch (e) {
      report.steps.build = { ok: false, error: e.message };
    }
  } else {
    // A2: npm i + npm run build
    try {
      console.log('  npm install (this may take 30-60s)...');
      const installRes = await execP('npm install --no-audit --no-fund --prefer-offline', {
        cwd: variantDir,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      console.log('  npm run build...');
      const buildRes = await execP('npm run build', {
        cwd: variantDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      report.steps.build = {
        ok: true,
        installStdoutTail: installRes.stdout.slice(-500),
        buildStdoutTail: buildRes.stdout.slice(-500),
      };
    } catch (e) {
      report.steps.build = {
        ok: false,
        error: e.message,
        stdoutTail: (e.stdout || '').slice(-1500),
        stderrTail: (e.stderr || '').slice(-1500),
      };
    }
  }
  console.log(`  build ok=${report.steps.build.ok}`);

  // ===== Launch the page =====
  let serverProc = null;
  let pageUrl;
  if (variant === 'a1') {
    pageUrl = pathToFileURL(path.join(variantDir, 'index.html')).href;
  } else {
    if (!report.steps.build.ok) {
      console.log('  skip launch — build failed');
      report.steps.runtime = { ok: false, skipped: 'build failed' };
      report.steps.screenshot = { ok: false, skipped: 'build failed' };
      report.steps.playability = { ok: false, skipped: 'build failed' };
      await writeReport(variant, report);
      return;
    }
    console.log('  starting vite preview on :8080...');
    serverProc = spawn('npx', ['vite', 'preview', '--port', '8080', '--strictPort'], {
      cwd: variantDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((res) => setTimeout(res, 3000));
    pageUrl = 'http://localhost:8080';
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // ===== 2. runtime smoke =====
  console.log(`[${variant.toUpperCase()}] === runtime smoke ===`);
  try {
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(5000); // 给游戏 5 秒跑 main loop
    const meta = await page.evaluate(() => ({
      hasGameMeta: typeof window.__GAME_META__ !== 'undefined',
      hasSnapshot: typeof window.snapshot === 'function',
      bodyCanvases: document.querySelectorAll('canvas').length,
      snapshot: typeof window.snapshot === 'function' ? (() => { try { return window.snapshot(); } catch (e) { return { error: String(e) }; } })() : null,
    }));
    report.steps.runtime = {
      ok: consoleErrors.length === 0 && pageErrors.length === 0 && meta.bodyCanvases > 0,
      consoleErrors: consoleErrors.slice(0, 10),
      pageErrors: pageErrors.slice(0, 10),
      consoleErrorCount: consoleErrors.length,
      pageErrorCount: pageErrors.length,
      ...meta,
    };
  } catch (e) {
    report.steps.runtime = { ok: false, error: e.message };
  }
  console.log(`  runtime ok=${report.steps.runtime.ok} consoleErrors=${report.steps.runtime.consoleErrorCount}`);

  // ===== 3. screenshot =====
  console.log(`[${variant.toUpperCase()}] === screenshot ===`);
  try {
    const shotPath = path.join(ROOT, 'screenshots', `${variant}-firstframe.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    report.steps.screenshot = { ok: true, path: path.relative(ROOT, shotPath) };
  } catch (e) {
    report.steps.screenshot = { ok: false, error: e.message };
  }

  // ===== 4. playability =====
  console.log(`[${variant.toUpperCase()}] === playability ===`);
  try {
    await page.click('body', { force: true }).catch(() => {}); // 给 canvas 焦点
    await page.evaluate(() => window.focus());

    // 跳过 title screen
    await page.keyboard.press('Space'); await page.waitForTimeout(500);
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    await page.keyboard.press('Space'); await page.waitForTimeout(800);

    const before = await page.evaluate(() => (typeof window.snapshot === 'function' ? window.snapshot() : null));

    // 长按 ArrowRight + 间隔跳跃 (模拟真实玩家)
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 25; i++) {
      if (i === 5 || i === 12 || i === 18) await page.keyboard.press('Space');
      if (i === 9 || i === 16) await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
    }
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => (typeof window.snapshot === 'function' ? window.snapshot() : null));

    const shotPath = path.join(ROOT, 'screenshots', `${variant}-after-play.png`);
    await page.screenshot({ path: shotPath, fullPage: false });

    const playerMoved = before && after && before.player && after.player && (
      Math.abs((after.player.x ?? 0) - (before.player.x ?? 0)) > 10 ||
      Math.abs((after.player.y ?? 0) - (before.player.y ?? 0)) > 10
    );
    const enemiesDelta = before && after ? ((after.enemiesDefeated ?? 0) - (before.enemiesDefeated ?? 0)) : 0;
    const blocksDelta = before && after ? ((after.blocksUsed ?? 0) - (before.blocksUsed ?? 0)) : 0;
    const gotDoubleJump = before && after && !before.abilities?.doubleJump && after.abilities?.doubleJump;

    report.steps.playability = {
      ok: !!(before && after && playerMoved),
      before,
      after,
      derived: { playerMoved, enemiesDelta, blocksDelta, gotDoubleJump },
      consoleErrorsDuringPlay: consoleErrors.length,
      pageErrorsDuringPlay: pageErrors.length,
      consoleErrorSamples: consoleErrors.slice(0, 5),
      pageErrorSamples: pageErrors.slice(0, 5),
      afterPlayScreenshot: path.relative(ROOT, shotPath),
    };
  } catch (e) {
    report.steps.playability = { ok: false, error: e.message };
  }
  console.log(`  playability ok=${report.steps.playability.ok}`);

  await browser.close();
  if (serverProc) {
    try { process.kill(-serverProc.pid); } catch {}
    try { serverProc.kill('SIGKILL'); } catch {}
  }

  await writeReport(variant, report);
}

async function writeReport(variant, report) {
  report.finished = new Date().toISOString();
  const out = path.join(ROOT, `${variant}-report.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport saved: ${out}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
