// 判据 2 真机腿：同一个人两通不同会话 → 第二通认出是本人。
// 第一通：说话建立主说话人聚类 → 设置页 IPC 显式注册（这是唯一的注册入口）
// 第二通：同一个人再说话 → 日志应出现 owner recognized 且声纹库 lastMatchedAt 前移
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_BASE = 'http://localhost:8182';
const DATA_DIR = path.join(os.homedir(), '.code-agent-dev2');
const say = (voice, text, out) => {
  const aiff = out.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', voice, '-o', aiff, `${text} [[slnc 3000]]`]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
};

const wav = path.join(os.tmpdir(), 'voiceprint-owner.wav');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-owner-'));
const parts = [
  '你好，请用两句话讲一讲上海的秋天。',
  '再说说适合去哪里散步。',
  '好的，那还有别的推荐吗？',
].map((t, i) => { const w = path.join(tmp, `${i}.wav`); say('Tingting', t, w); return w; });
const list = path.join(tmp, 'l.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);

async function runCall(label, seconds, afterCall) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto(`${URL_BASE}/`);
  await page.waitForSelector('.h-screen', { timeout: 40000 });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const token = window.__CODE_AGENT_TOKEN__ ?? '';
    await fetch(`/api/sessions?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  });
  await page.reload();
  await page.waitForSelector('.h-screen', { timeout: 40000 });
  await page.waitForTimeout(2000);
  await page.locator('[data-testid="live-voice-button"]').first().click({ timeout: 20000 });
  console.log(JSON.stringify({ step: `${label}:started` }));
  await page.waitForTimeout(seconds * 1000);
  let extra = null;
  if (afterCall) extra = await page.evaluate(afterCall);
  await browser.close();
  // host 侧 client gone → 等 VOICE_RECONNECT_GRACE_MS(15s) 宽限窗过了才真 teardown；
  // 期间开新通话会撞全局单路互斥（首轮就栽在只等 5s）。18s 留余量。
  await new Promise((r) => setTimeout(r, 18000));
  return extra;
}

// 第一通：说够话 → 通话进行中显式注册
const registered = await runCall('call-1', 45, async () => {
  const api = window.codeAgentDomainAPI || window.domainAPI;
  const before = await api.invoke('voice', 'voiceprintOverview');
  const reg = await api.invoke('voice', 'voiceprintRegister');
  return { before: before?.data, register: reg?.data };
});
console.log(JSON.stringify({ step: 'register', ...registered }));

const profilePath = path.join(DATA_DIR, 'voiceprint', 'owner-profile.json');
const afterReg = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
console.log(JSON.stringify({ step: 'profile-after-register',
  exists: !!afterReg, samples: afterReg?.embeddings?.length ?? 0, lastMatchedAt: afterReg?.lastMatchedAt }));

// 第二通：同一个人 → 应认出本人
await new Promise((r) => setTimeout(r, 2000));
await runCall('call-2', 40, null);
const afterCall2 = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
console.log(JSON.stringify({ step: 'profile-after-call2',
  lastMatchedAt: afterCall2?.lastMatchedAt,
  advanced: !!(afterCall2 && afterReg && afterCall2.lastMatchedAt > afterReg.lastMatchedAt),
  samplesUnchanged: afterCall2?.embeddings?.length === afterReg?.embeddings?.length }));
fs.rmSync(tmp, { recursive: true, force: true });
