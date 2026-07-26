// 一次性：一通短通话造出摘要卡，然后只重拍亮主题两张（摘要卡 + 设置页）。
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const OUT = '/Users/linchen/Downloads/ai/code-agent-private-archive/docs/plans/voice-p1b-screenshots';
const aiff = path.join(os.tmpdir(), 'voice-p1b-light.aiff');
const wav = path.join(os.tmpdir(), 'voice-p1b-light.wav');
execFileSync('say', ['-v', 'Tingting', '-o', aiff, '你好。 [[slnc 3000]]']);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);

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
const page = await context.newPage();
await page.goto('http://localhost:8181/');
await page.waitForSelector('.h-screen', { timeout: 20_000 });
await page.waitForTimeout(2000);

// 新空会话 + 短通话
await page.evaluate(async () => {
  const token = window.__CODE_AGENT_TOKEN__;
  await fetch(`/api/sessions?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
});
await page.reload();
await page.waitForSelector('.h-screen', { timeout: 20_000 });
await page.waitForTimeout(1500);
await page.locator('[data-testid="live-voice-button"]').click();
await page.waitForSelector('[data-testid="voice-chrome"][data-state="listening"], [data-testid="voice-chrome"][data-state="speaking"]', { timeout: 20_000 });
await page.waitForTimeout(12_000); // 让一轮问答发生，字幕落库
await page.locator('[data-testid="voice-end"]').click();
await page.waitForTimeout(2500);
if ((await page.locator('[data-testid="voice-call-summary-card"]').count()) !== 1) {
  console.error('summary card missing after call'); process.exit(1);
}

// 亮主题
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '09-summary-card-light.png') });

await page.locator('[aria-label="用户菜单"], [aria-label="Account menu"]').first().click();
await page.waitForTimeout(400);
await page.getByText('设置', { exact: true }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /^语音$/ }).first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '10-settings-live-light.png') });
await browser.close();
console.log('light reshoot done');
