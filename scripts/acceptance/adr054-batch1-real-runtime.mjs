// ADR-054 batch 1 real-runtime acceptance against an installed Agent Neo Dev host.
//
// This intentionally uses the real DashScope realtime connection and the real task
// engine. Chromium only supplies a deterministic microphone recording so the two
// timing-sensitive narration cases can be replayed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE_URL = process.env.CODE_AGENT_URL?.trim() || 'http://127.0.0.1:8181';
const DATA_DIR = process.env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), '.code-agent-dev');
const EXPECTED_ROOT = process.env.ADR054_EXPECTED_ROOT?.trim() || process.cwd();
const LOG_PATH = path.join(DATA_DIR, 'logs', `code-agent-${new Date().toISOString().slice(0, 10)}.log`);
const OUT_DIR = process.env.ADR054_EVIDENCE_DIR?.trim()
  || path.join(os.tmpdir(), `adr054-batch1-real-runtime-${Date.now()}`);
const TASK_TIMEOUT_MS = 180_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

function record(step, ok, detail = {}) {
  console.log(JSON.stringify({ step, ok, detail }));
  if (!ok) throw new Error(`${step} failed: ${JSON.stringify(detail)}`);
}

function makeWav(outPath, shortName) {
  const aiff = outPath.replace(/\.wav$/, '.aiff');
  const filler = Array.from(
    { length: 34 },
    () => '我正在连续说话，请等我把这一段说完再播报结果',
  ).join('，');
  const text = [
    `请派一个后台任务，短名叫${shortName}。`,
    '任务必须调用 Write 工具把“投递验证完成”写入当前工作目录的 hangup-voice-proof.txt，然后回复一句投递验证完成。',
    '[[slnc 2500]]',
    filler,
    '[[slnc 6000]]',
  ].join('');
  execFileSync('say', ['-v', 'Tingting', '-o', aiff, text]);
  // sox writes the canonical RIFF/PCM shape Chromium accepts. Do not use
  // afconvert here: its WAVE output has produced silent fake-capture frames on
  // Chromium. Keeping this independent from ffmpeg also avoids optional codec
  // dylibs affecting a PCM-only acceptance fixture.
  execFileSync('sox', [aiff, '-c', '1', '-r', '16000', '-b', '16', '-e', 'signed-integer', outPath]);
}

class LogProbe {
  constructor(logPath) {
    this.logPath = logPath;
    this.offset = fs.statSync(logPath).size;
    this.remainder = '';
    this.events = [];
  }

  pump() {
    const size = fs.statSync(this.logPath).size;
    if (size <= this.offset) return;
    const fd = fs.openSync(this.logPath, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const lines = `${this.remainder}${buffer.toString('utf8')}`.split('\n');
      this.remainder = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // A partial/non-JSON diagnostic is irrelevant to the structured proof.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.pump();
      const found = this.events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for log event: ${label}`);
  }
}

function eventData(event) {
  return Array.isArray(event?.data) && event.data[0] && typeof event.data[0] === 'object'
    ? event.data[0]
    : {};
}

async function api(page, method, route, body) {
  return page.evaluate(async ({ requestMethod, requestRoute, requestBody }) => {
    const token = window.__CODE_AGENT_TOKEN__;
    const separator = requestRoute.includes('?') ? '&' : '?';
    const response = await fetch(`${requestRoute}${separator}token=${encodeURIComponent(token)}`, {
      method: requestMethod,
      headers: { 'Content-Type': 'application/json' },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${requestMethod} ${requestRoute} failed: ${JSON.stringify(payload)}`);
    return payload;
  }, { requestMethod: method, requestRoute: route, requestBody: body });
}

async function waitForApp(page) {
  await page.goto(`${BASE_URL}/`);
  await page.waitForSelector('.h-screen', { timeout: 20_000 });
  await page.waitForTimeout(1_500);
}

async function configureServerVad(page) {
  await page.locator('[aria-label="用户菜单"], [aria-label="Account menu"]').first().click();
  await page.getByText('设置', { exact: true }).first().click();
  await page.getByRole('button', { name: /^实时语音$/ }).first().click();
  const liveToggle = page.locator('[data-testid="voice-live-settings"] [role="switch"]');
  if ((await liveToggle.getAttribute('aria-checked')) !== 'true') await liveToggle.click();
  await page.locator('[data-testid="voice-interrupt-server_vad"]').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function createSession(page, title, workingDirectory) {
  const response = await api(page, 'POST', '/api/sessions', { title, workingDirectory });
  const sessionId = response?.data?.id;
  if (!response?.success || typeof sessionId !== 'string') {
    throw new Error(`Session creation returned an unexpected payload: ${JSON.stringify(response)}`);
  }
  await page.reload();
  await page.waitForSelector('.h-screen', { timeout: 20_000 });
  await page.waitForTimeout(1_500);
  return sessionId;
}

async function waitForProjectedTerminal(page, sessionId, workItemId) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await api(page, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=300`);
    const message = response?.data?.find((entry) => entry?.metadata?.backgroundTaskResult?.taskId === workItemId);
    if (message) return message;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for projected terminal result for ${workItemId}`);
}

async function launch(wavPath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  return { browser, page };
}

async function readAndSetExecutionModel(executionModel) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await waitForApp(page);
    const current = await api(page, 'GET', '/api/settings');
    const original = current?.data?.voice?.live?.executionModel;
    const updated = await api(page, 'PUT', '/api/settings', {
      voice: { live: { executionModel } },
    });
    if (updated?.success !== true) {
      throw new Error(`Execution model update failed: ${JSON.stringify(updated)}`);
    }
    return original;
  } finally {
    await browser.close();
  }
}

async function startScenario({ name, hangUpWithPendingTerminal }) {
  const scenarioDir = path.join(OUT_DIR, name);
  fs.mkdirSync(scenarioDir, { recursive: true });
  const workingDirectory = path.join(scenarioDir, 'work');
  fs.mkdirSync(workingDirectory, { recursive: true });
  const wavPath = path.join(scenarioDir, 'input.wav');
  makeWav(wavPath, hangUpWithPendingTerminal ? '挂断验证' : '延迟投递');

  const probe = new LogProbe(LOG_PATH);
  const { browser, page } = await launch(wavPath);
  try {
    await waitForApp(page);
    await configureServerVad(page);
    const sessionId = await createSession(page, `ADR054 ${name}`, workingDirectory);

    await page.locator('[data-testid="live-voice-button"]').click();
    await page.waitForSelector(
      '[data-testid="voice-chrome"][data-state="listening"], [data-testid="voice-chrome"][data-state="speaking"], [data-testid="voice-chrome"][data-state="working"]',
      { timeout: 25_000 },
    );

    const dispatch = await probe.waitFor(
      (event) => event.message === 'voice work dispatched' && eventData(event).neoSessionId === sessionId,
      75_000,
      `${name}: voice work dispatched`,
    );
    const dispatchData = eventData(dispatch);
    const workItemId = dispatchData.workItemId;
    record(`${name}.dispatched`, typeof workItemId === 'string', {
      sessionId,
      workItemId,
      at: dispatch.timestamp,
    });

    const secondSpeech = await probe.waitFor(
      (event) => event.message === 'upstream event'
        && eventData(event).type === 'input_audio_buffer.speech_started'
        && Number(eventData(event).turn) >= 2,
      60_000,
      `${name}: second user speech started`,
    );

    const terminal = await waitForProjectedTerminal(page, sessionId, workItemId);
    const terminalResult = terminal.metadata.backgroundTaskResult;
    record(`${name}.terminal-while-user-speaking`, terminal.timestamp >= Date.parse(secondSpeech.timestamp), {
      speechStartedAt: secondSpeech.timestamp,
      terminalAt: new Date(terminal.timestamp).toISOString(),
      status: terminalResult.status,
      workItemId,
    });

    if (hangUpWithPendingTerminal) {
      await page.locator('[data-testid="voice-end"]').click();
      const fallback = await probe.waitFor(
        (event) => event.message === 'undelivered terminal narration fell back to notification'
          && eventData(event).workItemId === workItemId,
        15_000,
        `${name}: terminal notification fallback`,
      );
      const notification = await probe.waitFor(
        (event) => event.message === 'Voice work settlement notification sent'
          && eventData(event).sessionId === sessionId
          && eventData(event).taskTitle === terminalResult.shortName,
        15_000,
        `${name}: system notification delivered`,
      );
      record(`${name}.notification`, true, {
        at: fallback.timestamp,
        deliveredAt: notification.timestamp,
        taskTitle: eventData(notification).taskTitle,
        status: eventData(notification).status,
      });
    } else {
      const injected = await probe.waitFor(
        (event) => event.message === 'narration injected' && eventData(event).workItemId === workItemId,
        75_000,
        `${name}: narration injected after user turn`,
      );
      const confirmed = await probe.waitFor(
        (event) => event.message === 'narration delivery confirmed'
          && eventData(event).workItemId === workItemId
          && eventData(event).reason === 'playback',
        45_000,
        `${name}: playback acknowledgement`,
      );
      record(`${name}.playback-ack`, Date.parse(confirmed.timestamp) >= Date.parse(injected.timestamp), {
        injectedAt: injected.timestamp,
        confirmedAt: confirmed.timestamp,
        reason: eventData(confirmed).reason,
      });
      await page.locator('[data-testid="voice-end"]').click();
    }

    await page.screenshot({ path: path.join(scenarioDir, 'final.png'), fullPage: true });
    return { sessionId, workItemId, terminal: terminalResult, workingDirectory };
  } finally {
    await browser.close();
  }
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).then((response) => response.json());
  record('runtime.build', health?.status === 'ok' && health?.serverRoot === EXPECTED_ROOT, {
    pid: health?.pid,
    serverRoot: health?.serverRoot,
    expectedRoot: EXPECTED_ROOT,
    build: health?.build,
    rendererServe: health?.rendererServe,
  });

  const acceptanceModel = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const originalExecutionModel = await readAndSetExecutionModel(acceptanceModel);
  record('runtime.execution-model', true, { acceptanceModel, originalExecutionModel });
  try {
    const only = process.env.ADR054_BATCH1_ONLY?.trim();
    const delivered = only === 'hangup-notification'
      ? null
      : await startScenario({ name: 'suppressed-then-delivered', hangUpWithPendingTerminal: false });
    const hungUp = only === 'suppressed-then-delivered'
      ? null
      : await startScenario({ name: 'hangup-notification', hangUpWithPendingTerminal: true });
    record('summary', true, { evidenceDir: OUT_DIR, delivered, hungUp });
  } finally {
    await readAndSetExecutionModel(originalExecutionModel);
    record('runtime.execution-model-restored', true, { originalExecutionModel });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
