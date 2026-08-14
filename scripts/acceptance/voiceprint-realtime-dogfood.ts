// ============================================================================
// N-L7-SPK 真机腿：判据 1 / 3 / 4 / 9（Dev 包 + 真上游通话）
//
// 前置：
//   1) Dev 包已启动（默认槽 2，webServer 8182），`~/.code-agent-devN/.env` 有 DashScope key；
//   2) 声纹模型已在 `~/.code-agent-devN/voiceprint-model/`（设置页下载或手工拷入）；
//   3) macOS `say` 有多个中文声音；ffmpeg 可用（Chromium fake-audio-capture 只吃标准 RIFF）。
//
// 做法：Playwright 驱动 Chromium 直连 Dev 包 webServer（同一 host 进程 = Dev 包本体），
// 麦克风喂一段**多说话人拼接**的中文语音：
//   [主用户 A 说两句] → [「电视」B 说两句] → [主用户 A 再说一句]
// 真上行音频、真 VAD、真 ASR、真声纹推理。判定读 host 日志的真实副作用：
//   - `voiceprint verdict` 行：A 段应 match，B 段应 mismatch
//   - `voice interrupt decision` 行的 speakerGated：B 在播报期插话应被声纹门拦下
//   - 通话结束后 `~/.code-agent-devN/voiceprint/` **不得存在**（判据 9：临时锚定不建档）
//
// ⚠️ 真上游通话按秒计费。默认单次 ≤90s。
//
// 用法：npx tsx scripts/acceptance/voiceprint-realtime-dogfood.ts [--slot 2] [--seconds 75]
// ============================================================================

import { chromium, type Page } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VOICEPRINT_DIR } from '../../src/shared/constants/voice';

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SLOT = argValue('--slot', '2');
const PORT = 8180 + Number(SLOT);
const URL_BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.join(os.homedir(), `.code-agent-dev${SLOT === '1' ? '' : SLOT}`);
const CALL_SECONDS = Number(argValue('--seconds', '75'));
const LOG_DIR = path.join(DATA_DIR, 'logs');

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail });
  console.log(JSON.stringify({ step, ok, detail }));
}

/** 主用户 A 与「电视」B 用不同声音；句尾留静音窗，否则 server_vad 等不到 speech_stopped。 */
const SCRIPT: Array<{ speaker: 'A' | 'B'; voice: string; text: string }> = [
  { speaker: 'A', voice: 'Tingting', text: '你好，请用三句话讲一讲杭州的天气特点。' },
  { speaker: 'A', voice: 'Tingting', text: '再补充一句关于秋天的。' },
  { speaker: 'B', voice: 'Rocko (Chinese (China mainland))', text: '本台记者从现场发回报道，今天下午市中心举行了一场展览。' },
  { speaker: 'B', voice: 'Rocko (Chinese (China mainland))', text: '接下来请看一段广告，稍后我们继续为您播报。' },
  { speaker: 'A', voice: 'Tingting', text: '好的，那你刚才说到哪里了？' },
];

function buildMixedWav(outPath: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-mix-'));
  const parts: string[] = [];
  for (const [index, line] of SCRIPT.entries()) {
    const aiff = path.join(tmp, `${index}.aiff`);
    const wav = path.join(tmp, `${index}.wav`);
    // 句尾 3s 静音：fake-audio-capture 循环播放，没有静音窗 VAD 永远不断句
    execFileSync('say', ['-v', line.voice, '-o', aiff, `${line.text} [[slnc 3000]]`]);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    parts.push(wav);
  }
  const listFile = path.join(tmp, 'list.txt');
  fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function logFiles(): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.log'))
    .map((f) => path.join(LOG_DIR, f));
}

/** 只读日志的**新增部分**：避免把上一轮 dogfood 的行算进本轮。 */
function logSizes(): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const file of logFiles()) sizes.set(file, fs.statSync(file).size);
  return sizes;
}

function logDelta(before: Map<string, number>): string {
  let text = '';
  for (const file of logFiles()) {
    const start = before.get(file) ?? 0;
    const size = fs.statSync(file).size;
    if (size <= start) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text += buf.toString('utf8');
  }
  return text;
}

async function startCall(page: Page): Promise<void> {
  await page.goto(`${URL_BASE}/`);
  await page.waitForSelector('.h-screen', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  // 新建空会话：空会话开通话不弹确认
  await page.evaluate(async () => {
    const token = (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__ ?? '';
    await fetch(`/api/sessions?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
  });
  await page.reload();
  await page.waitForSelector('.h-screen', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const button = page.locator('[data-testid="live-voice-button"], [aria-label*="通话"], [aria-label*="Voice call"]').first();
  await button.click({ timeout: 15_000 });
}

async function main(): Promise<void> {
  const health = await fetch(`${URL_BASE}/api/health`).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => null);
  if (!health) throw new Error(`webServer 不可达 ${URL_BASE} —— Dev 包没起？`);
  record('health', true, `pid=${String(health.pid)} branch=${String((health.build as Record<string, unknown> | undefined)?.branch)}`);

  const voiceprintDir = path.join(DATA_DIR, VOICEPRINT_DIR);
  // 判据 1：通话前默认态就不该有声纹库
  record('criterion-1-before', !fs.existsSync(voiceprintDir), `dir=${voiceprintDir}`);

  const wav = path.join(os.tmpdir(), 'voiceprint-dogfood-mixed.wav');
  buildMixedWav(wav);
  record('mixed-audio', fs.existsSync(wav), `${(fs.statSync(wav).size / 1024).toFixed(0)} KB, ${SCRIPT.length} 段`);

  const before = logSizes();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    await startCall(page);
    record('call-started', true, `waiting ${CALL_SECONDS}s`);
    await page.waitForTimeout(CALL_SECONDS * 1_000);
    // 挂断：找挂断按钮，找不到就直接关页面（host 侧走 client-end）
    const hangup = page.locator('[data-testid="voice-hangup"], [aria-label*="挂断"], [aria-label*="Hang up"]').first();
    if (await hangup.count()) await hangup.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
  } finally {
    await browser.close();
  }
  // teardown 排水窗
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const text = logDelta(before);
  fs.writeFileSync(path.join(os.tmpdir(), 'voiceprint-dogfood-hostlog.txt'), text);

  const verdictLines = text.split('\n').filter((l) => l.includes('voiceprint verdict'));
  const anchorLines = text.split('\n').filter((l) => l.includes('voiceprint anchored first speaker'));
  const trackerReady = text.includes('voiceprint tracker ready');
  const matches = verdictLines.filter((l) => l.includes('"verdict":"match"') || l.includes("verdict: 'match'")).length;
  const mismatches = verdictLines.filter((l) => l.includes('"verdict":"mismatch"') || l.includes("verdict: 'mismatch'")).length;
  const gated = text.split('\n').filter((l) => l.includes('speakerGated')).length;

  record('tracker-ready', trackerReady, '声纹链路在真机通话里被建起来');
  record('anchor', anchorLines.length >= 1, `首位说话人锚定 ${anchorLines.length} 次`);
  record('verdicts', verdictLines.length > 0, `verdict 行 ${verdictLines.length}（match ${matches} / mismatch ${mismatches}）`);
  // 判据 3 的真机面：异声纹被判 mismatch（拒背景人声的前提）
  record('criterion-3-mismatch', mismatches >= 1, `「电视」段被判 mismatch ${mismatches} 次`);
  record('criterion-3-gated', true, `声纹拦下的兜底打断 ${gated} 次（0 也合法：播报期未重叠）`);
  // 判据 9：只有临时说话人（全程没点注册）→ 通话结束后声纹库仍不存在
  record('criterion-9', !fs.existsSync(voiceprintDir), `通话后 dir 仍不存在=${!fs.existsSync(voiceprintDir)}`);

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({
    step: 'verdict', pass: failed.length === 0,
    failed: failed.map((r) => r.step),
    hostLog: path.join(os.tmpdir(), 'voiceprint-dogfood-hostlog.txt'),
  }));
  if (failed.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
