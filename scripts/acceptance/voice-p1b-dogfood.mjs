// ============================================================================
// voice-p1b 真机验证 + 审美截图脚本（Dev 包）
//
// 前置：
//   1) Dev 包（Agent Neo Dev）已启动，webServer 在 8181；
//   2) ~/.code-agent-dev/.env 有 DashScope key（真上游，通话计费，单次 ≤60s）；
//   3) macOS `say` 有 Tingting（zh_CN）语音。
//
// 做法：Playwright 驱动 Chromium 直连 Dev 包的 webServer（同一 renderer bundle
// + 同一 host 进程 = Dev 包本体）。麦克风用 Chromium fake-audio-capture 喂
// `say` 生成的中文语音 wav —— 真上行音频、真 VAD、真 ASR、真派活。
//
// 产出：截图落 code-agent-private-archive/docs/plans/voice-p1b-screenshots/，
// stdout 打每步验证结论（JSON lines），供收口报告引用。
//
// 用法：node scripts/acceptance/voice-p1b-dogfood.mjs [--out <dir>] [--url <url>]
// ============================================================================

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_BASE = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:8181';
const OUT_DIR = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/Users/linchen/Downloads/ai/code-agent-private-archive/docs/plans/voice-p1b-screenshots';

const results = [];
function record(step, ok, detail = '') {
  results.push({ step, ok, detail });
  console.log(JSON.stringify({ step, ok, detail }));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  record(`screenshot:${name}`, true);
}

function makeWav(text, outPath) {
  const aiff = outPath.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', 'Tingting', '-o', aiff, text]);
  // afconvert 的 WAVE 封装 Chromium fake-audio-capture 解析不出（喂进去全零帧，
  // 真机踩到：VAD 永不触发、通话一片沉默）——必须用 ffmpeg 出标准 RIFF pcm_s16le。
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath]);
  return outPath;
}

async function waitForAppReady(page) {
  await page.goto(`${URL_BASE}/`);
  await page.waitForSelector('.h-screen', { timeout: 20_000 });
  // 初始会话 settle
  await page.waitForTimeout(1500);
}

async function newSession(page) {
  // 走 REST 建空会话再 reload：host setCurrentSession + 列表 updatedAt 倒序，
  // 重载后新空会话即当前会话（空会话 = 开通话无确认弹窗的 B1 路径）。
  await page.evaluate(async () => {
    const token = window.__CODE_AGENT_TOKEN__;
    await fetch(`/api/sessions?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });
  await page.reload();
  await page.waitForSelector('.h-screen', { timeout: 20_000 });
  await page.waitForTimeout(1500);
}

async function openVoiceSettings(page) {
  // 侧栏底部账户菜单 → 设置（没有直出按钮）
  await page.locator('[aria-label="用户菜单"], [aria-label="Account menu"]').first().click();
  await page.waitForTimeout(400);
  await page.getByText('设置', { exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /^语音$/ }).first().click();
  await page.waitForTimeout(600);
}

async function setInterruptMode(page, testId) {
  await openVoiceSettings(page);
  await page.locator(`[data-testid="${testId}"]`).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function launchBrowser(wav) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  return { browser, context };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 0. Dev 包 webServer 存活 + bundle 指纹
  const health = await fetch(`${URL_BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`webServer not reachable at ${URL_BASE} — Dev 包未启动？`);
  record('health', true, `pid=${health.pid}`);

  // 句尾 [[slnc 3000]]：fake-audio-capture 循环播放，没有 ≥500ms 静音窗 server_vad
  // 永远等不到 speech_stopped（批 A 教训），每轮循环留 3s 静音。
  const chatWav = makeWav('你好，请用一句话介绍你自己。 [[slnc 3000]]', path.join(os.tmpdir(), 'voice-p1b-chat.wav'));
  const taskWav = makeWav('帮我在当前目录写一个 hello 文本文件。 [[slnc 3000]]', path.join(os.tmpdir(), 'voice-p1b-task.wav'));

  // ── 会话 A：设置页 + 全双工通话（listening/speaking/muted/echo-hint/summary）──
  {
    const { browser, context } = await launchBrowser(chatWav);
    const page = await context.newPage();
    await waitForAppReady(page);

    // 设置 → 语音：开总开关，核对 Provider 状态
    await setInterruptMode(page, 'voice-interrupt-server_vad');
    await openVoiceSettings(page);
    const providerStatus = await page.locator('[data-testid="voice-provider-status"]').textContent();
    record('settings.providerConfigured', (providerStatus ?? '').includes('已配置'), providerStatus ?? '');
    const liveToggle = page.locator('[data-testid="voice-live-settings"] [role="switch"]');
    if ((await liveToggle.getAttribute('aria-checked')) !== 'true') {
      await liveToggle.click();
      await page.waitForTimeout(500);
    }
    record('settings.enabled', (await liveToggle.getAttribute('aria-checked')) === 'true');
    await shot(page, '01-settings-live-dark');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // 空会话直接开（B1：无确认弹窗）
    await newSession(page);
    const liveBtn = page.locator('[data-testid="live-voice-button"]');
    await liveBtn.waitFor({ timeout: 10_000 });
    record('entry.visible', true);
    await shot(page, '02-idle-entry-dark');
    await liveBtn.click();
    // connecting 是瞬态，抓得到就留证
    await page.waitForTimeout(250);
    const connecting = await page.locator('[data-testid="voice-chrome"]').getAttribute('data-state');
    record('state.connecting-seen', connecting === 'connecting' || connecting === 'live', connecting ?? '');
    await shot(page, '03-connecting-dark');

    // live：listening
    await page.waitForSelector('[data-testid="voice-chrome"][data-state="listening"], [data-testid="voice-chrome"][data-state="speaking"], [data-testid="voice-chrome"][data-state="working"]', { timeout: 20_000 });
    record('state.live', true);
    await shot(page, '04-listening-dark');
    // B7 回声提示 toast（首次通话、无耳机标签的 fake 设备环境应出现；8s 内抓）
    const echoToast = page.locator('text=建议佩戴耳机');
    if (await echoToast.isVisible().catch(() => false)) {
      await shot(page, '05-echo-hint-dark');
      record('b7.echoHint', true);
    } else {
      record('b7.echoHint', false, 'toast 未出现（可能已被不再提示标记压制）');
    }

    // speaking（assistant 应答）
    const spoke = await page.waitForSelector('[data-testid="voice-chrome"][data-state="speaking"]', { timeout: 45_000 }).then(() => true).catch(() => false);
    record('state.speaking', spoke);
    if (spoke) await shot(page, '06-speaking-dark');

    // muted
    await page.locator('[data-testid="voice-mute"]').click();
    await page.waitForSelector('[data-testid="voice-chrome"][data-state="muted"]', { timeout: 5_000 });
    await shot(page, '07-muted-dark');
    await page.locator('[data-testid="voice-mute"]').click();

    // partial 字幕行出现过就算（瞬态）
    // 挂断 → 摘要卡
    await page.locator('[data-testid="voice-end"]').click();
    await page.waitForTimeout(2500);
    const summary = page.locator('[data-testid="voice-call-summary-card"]');
    const summaryCount = await summary.count();
    record('summary.card', summaryCount === 1, `count=${summaryCount}`);
    if (summaryCount === 1) await shot(page, '08-summary-card-dark');
    const badges = await page.locator('[data-testid="voice-source-badge"]').count();
    record('summary.voiceBadges', badges >= 1, `count=${badges}`);

    // B1 确认弹窗：会话已有消息，再点入口必须弹「延续上下文」确认
    await page.locator('[data-testid="live-voice-button"]').click();
    const confirmDlg = page.getByText('在本会话开启实时语音并延续当前上下文？');
    const confirmShown = await confirmDlg.isVisible({ timeout: 5_000 }).catch(() => false);
    record('entry.confirmDialog', confirmShown);
    if (confirmShown) await shot(page, '08b-confirm-dialog-dark');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // 亮主题（CSS 类切换，视觉验收用）
    await page.evaluate(() => {
      // 主题真源是 data-theme 属性（dark.css/light.css 都按它匹配），class 只喂 Tailwind
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    });
    await page.waitForTimeout(400);
    await shot(page, '09-summary-card-light');
    await openVoiceSettings(page);
    await shot(page, '10-settings-live-light');
    await page.keyboard.press('Escape');

    await browser.close();
  }

  // ── 会话 B：派活 → working 态（best-effort，依赖模型真调 delegate_task）──
  {
    const { browser, context } = await launchBrowser(taskWav);
    const page = await context.newPage();
    await waitForAppReady(page);
    await setInterruptMode(page, 'voice-interrupt-server_vad');
    await newSession(page);
    await page.locator('[data-testid="live-voice-button"]').click();
    await page.waitForSelector('[data-testid="voice-chrome"]', { timeout: 20_000 });
    const worked = await page.waitForSelector('[data-testid="voice-work-item-queued"]', { timeout: 60_000 }).then(() => true).catch(() => false);
    record('state.working', worked, worked ? '' : '60s 内模型未派活（真机 best-effort）');
    if (worked) await shot(page, '11-working-dark');
    await page.locator('[data-testid="voice-end"]').click();
    await browser.close();
  }

  // ── 会话 C：PTT 模式 + error 态 ──
  {
    const { browser, context } = await launchBrowser(chatWav);
    const page = await context.newPage();
    await waitForAppReady(page);
    await setInterruptMode(page, 'voice-interrupt-push_to_talk');
    await newSession(page);
    await page.locator('[data-testid="live-voice-button"]').click();
    await page.waitForSelector('[data-testid="voice-chrome"]', { timeout: 20_000 });
    const ptt = page.locator('[data-testid="voice-ptt"]');
    await ptt.waitFor({ timeout: 10_000 });
    record('ptt.button', true);
    await shot(page, '12-ptt-idle-dark');
    // 必须等真 live 再按：connecting 相位下 bridge.pttDown 是 no-op（首轮就踩到）
    await page.waitForSelector('[data-testid="voice-chrome"][data-state="listening"]', { timeout: 20_000 });

    // 按住 6s（fake wav 在放）→ 松开 commit → 等应答
    await ptt.dispatchEvent('pointerdown');
    await page.waitForTimeout(6000);
    await shot(page, '13-ptt-holding-dark');
    await ptt.dispatchEvent('pointerup');
    const pttAnswer = await page.waitForSelector('[data-testid="voice-chrome"][data-state="speaking"]', { timeout: 45_000 }).then(() => true).catch(() => false);
    record('ptt.commit-answer', pttAnswer);
    await page.locator('[data-testid="voice-end"]').click();
    await page.waitForTimeout(1200);

    // error 态：断网拨号 → 握手失败（当前页面直接拨，离线 reload 会把页面打死——首轮踩到）
    await context.setOffline(true);
    await page.locator('[data-testid="live-voice-button"]').click();
    // 上一通留下字幕 → 有消息会话先弹确认（B1），确认后才开始拨号
    const confirmBtn = page.getByRole('button', { name: '开启通话' });
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) await confirmBtn.click();
    const errored = await page.waitForSelector('[data-testid="voice-chrome"][data-state="error"]', { timeout: 15_000 }).then(() => true).catch(() => false);
    record('state.error', errored);
    if (errored) await shot(page, '14-error-dark');
    await context.setOffline(false);
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedSteps: failed.map((f) => f.step) } }));
  process.exit(failed.some((f) => ['settings.providerConfigured', 'entry.visible', 'state.live', 'summary.card', 'ptt.commit-answer'].includes(f.step)) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
