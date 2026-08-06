// ADR-054 batch 2 real-runtime acceptance against a locally built web host.
// The real realtime voice model dispatches two background tasks, the real task
// engine asks questions, and the user cancels one task through an ambiguous
// reference that must be clarified by short name.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE_URL = process.env.CODE_AGENT_URL?.trim() || 'http://127.0.0.1:8182';
const DATA_DIR = process.env.CODE_AGENT_DATA_DIR?.trim() || '/tmp/adr054-batch2-data';
const EXPECTED_ROOT = process.env.ADR054_EXPECTED_ROOT?.trim() || process.cwd();
const LOG_PATH = path.join(DATA_DIR, 'logs', `code-agent-${new Date().toISOString().slice(0, 10)}.log`);
const OUT_DIR = process.env.ADR054_EVIDENCE_DIR?.trim()
  || path.join(os.tmpdir(), `adr054-batch2-real-runtime-${Date.now()}`);
const SCENARIO_TIMEOUT_MS = 360_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

function record(step, ok, detail = {}) {
  console.log(JSON.stringify({ step, ok, detail }));
  if (!ok) throw new Error(`${step} failed: ${JSON.stringify(detail)}`);
}

function makeUtteranceWavs(outDir) {
  const firstTask = process.env.ADR054_BATCH2_STATUS_STEER === '1'
    ? [
      '请调用 spawn task。',
      'title 填工单报告，short name 填报告，lane key 填工单报告，submission key 填 batch2-report。',
      'prompt 填：先用 Ask User Question 问继续还是停止；继续后用 Bash 执行 sleep 180，再回复报告完成。',
    ].join('')
    : [
      '请调用 spawn task。',
      'title 填工单报告，short name 填报告，lane key 填工单报告，submission key 填 batch2-report。',
      'prompt 填：立即用 Bash 执行 sleep 300；命令结束后回复报告完成。不要调用其他工具。',
    ].join('');
  const secondTask = [
    '请再调用 spawn task。',
    'title 填资料查询，short name 填查询，lane key 填资料查询，submission key 填 batch2-query。',
    'prompt 填：先用 Bash 执行 sleep 45；然后用 Ask User Question 问现在完成还是继续等待；',
    '我答完成后回复查询完成。',
  ].join('');
  const utterances = {
    firstTask,
    firstContinue: '继续。',
    secondTask,
    ambiguousCancel: '请停止一个任务。请取消一个任务。停掉一个任务。',
    // 单音节级短回答在真实 server VAD 下偶尔只留下半个词；重复完整短名仍然验证
    // “按短名命中”，同时给 ASR 足够的稳定语音帧。
    cancelReport: '报告任务。请停止报告任务。',
    finishQuery: '完成。',
    steerQuery: '查询那件继续改成跳过等待，直接回复查询改向完成。',
    statusReport: '报告那件现在怎么样了？请查真实状态再回答。',
  };
  const wavs = {};
  for (const [name, utterance] of Object.entries(utterances)) {
    const wav = path.join(outDir, `${name}.wav`);
    execFileSync('say', [
      '-v', 'Tingting',
      '-o', wav,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      '--channels=1',
      utterance,
    ]);
    if (fs.statSync(wav).size <= 44) {
      throw new Error(`Speech synthesis returned an empty WAV: ${wav}`);
    }
    wavs[name] = wav;
  }
  return wavs;
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
          // Structured runtime evidence only.
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

  async waitForCount(predicate, count, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.pump();
      const matches = this.events.filter(predicate);
      if (matches.length >= count) return matches;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${count} log events: ${label}`);
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

async function installControllableMicrophone(page) {
  await page.addInitScript(() => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass({ sampleRate: 16_000 });
    const destination = context.createMediaStreamDestination();
    window.__ADR054_AUDIO__ = { context, destination };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => destination.stream,
    });
  });
}

async function playUtterance(page, wavPath) {
  const encoded = fs.readFileSync(wavPath).toString('base64');
  await page.evaluate(async (base64) => {
    const state = window.__ADR054_AUDIO__;
    if (!state) throw new Error('controllable microphone is not installed');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    await state.context.resume();
    const audio = await state.context.decodeAudioData(bytes.buffer.slice(0));
    const source = state.context.createBufferSource();
    source.buffer = audio;
    source.connect(state.destination);
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
    source.disconnect();
  }, encoded);
  await page.waitForTimeout(1_800);
}

async function playUntilDispatch(page, probe, wavPath, expectedCount, label) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await playUtterance(page, wavPath);
    try {
      return await probe.waitForCount(
        (event) => event.message === 'voice work dispatched',
        expectedCount,
        45_000,
        label,
      );
    } catch (error) {
      lastError = error;
      console.log(JSON.stringify({ step: `${label}.retry`, ok: true, detail: { attempt } }));
    }
  }
  throw lastError;
}

async function waitForNarrationDelivery(page, probe, narrationId, timeoutMs, label) {
  await probe.waitFor(
    (event) => event.message === 'narration delivery confirmed'
      && eventData(event).workItemId === narrationId,
    timeoutMs,
    `${label} delivery`,
  );
  // Delivery acknowledgement means playback started. Let the spoken question
  // drain before injecting the answer, otherwise the answer is a barge-in.
  await page.waitForTimeout(15_000);
}

function questionRequestId(narrationId) {
  return narrationId.match(/^voice-question:([^:]+):/)?.[1] ?? null;
}

async function waitForNextDeliveredQuestion(page, probe, knownRequestIds, timeoutMs, label) {
  const narration = await probe.waitFor(
    (event) => {
      if (event.message !== 'narration injected') return false;
      const narrationId = String(eventData(event).workItemId);
      const requestId = questionRequestId(narrationId);
      return Boolean(requestId) && !knownRequestIds.has(requestId);
    },
    timeoutMs,
    label,
  );
  const narrationId = String(eventData(narration).workItemId);
  const requestId = questionRequestId(narrationId);
  if (!requestId) throw new Error(`Question narration lacked request id: ${narrationId}`);
  await waitForNarrationDelivery(page, probe, narrationId, 15_000, label);
  knownRequestIds.add(requestId);
  return { narration, narrationId, requestId };
}

async function configureServerVad(page) {
  const current = await api(page, 'GET', '/api/settings');
  await api(page, 'PUT', '/api/settings', {
    voice: {
      turnDetection: {
        type: 'server_vad',
        threshold: 0.5,
        prefixPaddingMs: 500,
        silenceDurationMs: 1_000,
      },
      live: {
        ...(current?.data?.voice?.live ?? {}),
        enabled: true,
        interrupt: 'server_vad',
        vadSensitivity: 'medium',
      },
    },
  });
}

async function createSession(page, workingDirectory) {
  const response = await api(page, 'POST', '/api/sessions', {
    title: 'ADR054 Batch2 multi-slot real runtime',
    workingDirectory,
  });
  const sessionId = response?.data?.id;
  if (!response?.success || typeof sessionId !== 'string') {
    throw new Error(`Session creation returned an unexpected payload: ${JSON.stringify(response)}`);
  }
  await page.reload();
  await page.waitForSelector('.h-screen', { timeout: 20_000 });
  await page.waitForTimeout(1_500);
  return sessionId;
}

async function readTerminalResults(page, sessionId) {
  const response = await api(page, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=300`);
  return response?.data
    ?.map((entry) => entry?.metadata?.backgroundTaskResult)
    .filter(Boolean) ?? [];
}

async function waitForTerminalResults(page, sessionId, count) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const results = await readTerminalResults(page, sessionId);
    if (results.length >= count) return results;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${count} terminal results`);
}

async function setExecutionModel(page, executionModel) {
  const current = await api(page, 'GET', '/api/settings');
  const original = current?.data?.voice?.live?.executionModel;
  await api(page, 'PUT', '/api/settings', { voice: { live: { executionModel } } });
  return original;
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).then((response) => response.json());
  record('runtime.build', health?.status === 'ok' && health?.serverRoot === EXPECTED_ROOT, {
    pid: health?.pid,
    serverRoot: health?.serverRoot,
    expectedRoot: EXPECTED_ROOT,
    rendererServe: health?.rendererServe,
  });

  const scenarioDir = path.join(OUT_DIR, 'multi-slot');
  const workingDirectory = path.join(scenarioDir, 'work');
  fs.mkdirSync(workingDirectory, { recursive: true });
  const wavs = makeUtteranceWavs(scenarioDir);

  const probe = new LogProbe(LOG_PATH);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await installControllableMicrophone(page);
  let originalExecutionModel;
  try {
    await waitForApp(page);
    await configureServerVad(page);
    originalExecutionModel = await setExecutionModel(page, { provider: 'deepseek', model: 'deepseek-v4-pro' });
    const sessionId = await createSession(page, workingDirectory);
    const questionRequestIds = new Set();

    await page.locator('[data-testid="live-voice-button"]').click();
    await page.waitForSelector(
      '[data-testid="voice-chrome"][data-state="listening"], [data-testid="voice-chrome"][data-state="speaking"], [data-testid="voice-chrome"][data-state="working"]',
      { timeout: 25_000 },
    );

    await playUntilDispatch(page, probe, wavs.firstTask, 1, 'first dispatch');
    if (process.env.ADR054_BATCH2_STATUS_STEER === '1') {
      await waitForNextDeliveredQuestion(
        page,
        probe,
        questionRequestIds,
        120_000,
        'first task question',
      );
      await playUtterance(page, wavs.firstContinue);
      await probe.waitForCount(
        (event) => event.message === 'voice question answer accepted',
        1,
        20_000,
        'first task answer',
      );
    } else {
      await page.waitForTimeout(2_000);
    }

    const dispatches = await playUntilDispatch(page, probe, wavs.secondTask, 2, 'second dispatch');
    const dispatched = dispatches.slice(0, 2).map((event) => eventData(event));
    record('parallel.dispatch', new Set(dispatched.map((item) => item.workItemId)).size === 2
      && new Set(dispatched.map((item) => item.laneKey)).size === 2, { sessionId, dispatched });

    probe.pump();
    const acceptedToolCalls = probe.events
      .filter((event) => event.message === 'realtime voice tool call accepted')
      .map((event) => eventData(event));
    const channelCounts = acceptedToolCalls.reduce((counts, call) => {
      const origin = String(call.origin || 'unknown');
      counts[origin] = (counts[origin] ?? 0) + 1;
      return counts;
    }, {});
    record('tool.channels', acceptedToolCalls.length >= 2, { channelCounts, acceptedToolCalls });

    if (process.env.ADR054_BATCH2_STATUS_STEER === '1') {
      // 双派发落账后立即验证控制路径，避免把执行模型是否严格遵守提问文案
      // 变成 steer/status 场景的无关前置。
      await playUtterance(page, wavs.steerQuery);
      const steer = await probe.waitFor(
        (event) => (event.message === 'realtime voice tool call accepted'
            || event.message === 'voice action tool accepted')
          && eventData(event).toolName === 'steer_task',
        30_000,
        'spoken follow-up routed to steer_task',
      );
      await page.waitForTimeout(2_000);
      probe.pump();
      const dispatchCountAfterSteer = probe.events.filter(
        (event) => event.message === 'voice work dispatched',
      ).length;
      record('followup.same-lane-serialized', dispatchCountAfterSteer === 2, {
        steer: eventData(steer),
        dispatchCountAfterSteer,
        targetLane: dispatched[1].laneKey,
        targetWorkItemId: dispatched[1].workItemId,
      });

      await playUtterance(page, wavs.statusReport);
      const statusCall = await probe.waitFor(
        (event) => (event.message === 'realtime voice tool call accepted'
            || event.message === 'voice action tool accepted')
          && eventData(event).toolName === 'task_status',
        30_000,
        'short-name status query',
      );
      await page.waitForTimeout(8_000);
      const messages = await api(page, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=300`);
      const statusReply = [...(messages?.data ?? [])].reverse().find(
        (entry) => entry?.role === 'assistant'
          && entry?.metadata?.source === 'voice'
          && /报告/.test(String(entry?.content ?? '')),
      );
      record('status.short-name-route', Boolean(statusReply), {
        statusCall: eventData(statusCall),
        reply: statusReply?.content,
      });
      await page.screenshot({ path: path.join(scenarioDir, 'status-steer-final.png'), fullPage: true });
      await page.locator('[data-testid="voice-end"]').click().catch(() => undefined);
      record('summary', true, { evidenceDir: OUT_DIR, sessionId, dispatched, statusReply: statusReply?.content });
      return;
    }

    await playUtterance(page, wavs.ambiguousCancel);
    const cancellationQuestion = await waitForNextDeliveredQuestion(
      page,
      probe,
      questionRequestIds,
      30_000,
      'ambiguous cancellation question',
    );
    await playUtterance(page, wavs.cancelReport);

    let stopOrRetry = await probe.waitFor(
      (event) => event.message === 'stop requested'
        || (event.message === 'voice question narration requested'
          && eventData(event).requestId === cancellationQuestion.requestId
          && String(eventData(event).narrationId).endsWith(':retry')),
      30_000,
      'short-name cancellation or retry',
    );
    if (stopOrRetry.message !== 'stop requested') {
      const retryNarrationId = String(eventData(stopOrRetry).narrationId);
      await probe.waitFor(
        (event) => event.message === 'narration injected'
          && eventData(event).workItemId === retryNarrationId,
        15_000,
        'short-name cancellation retry narration',
      );
      await waitForNarrationDelivery(page, probe, retryNarrationId, 15_000, 'short-name cancellation retry');
      await playUtterance(page, wavs.cancelReport);
      stopOrRetry = await probe.waitFor(
        (event) => event.message === 'stop requested',
        30_000,
        'short-name cancellation routed after retry',
      );
    }
    const stop = stopOrRetry;
    const stoppedId = eventData(stop).workItemId;
    const stopped = dispatched.find((item) => item.workItemId === stoppedId);
    record('cancel.short-name-route', stopped?.workItemId === dispatched[0]?.workItemId, { stoppedId, stopped });

    record('questions.voice-rendered', questionRequestIds.size === 1, {
      requestIds: [...questionRequestIds],
    });
    await probe.waitForCount(
      (event) => event.message === 'voice question answer accepted',
      1,
      20_000,
      'cancellation selection',
    );

    // 被取消的是“报告”。“查询”的第二次提问仍能送达并接受回答，才证明取消没有
    // 误伤兄弟任务；不使用“等待 N 秒”这类模型无法可靠执行的自然语言计时。
    const survivingSiblingQuestion = await waitForNextDeliveredQuestion(
      page,
      probe,
      questionRequestIds,
      120_000,
      'surviving sibling second question',
    );
    await playUtterance(page, wavs.finishQuery);
    await probe.waitForCount(
      (event) => event.message === 'voice question answer accepted',
      2,
      20_000,
      'surviving sibling answer',
    );

    const terminalResults = await waitForTerminalResults(page, sessionId, 2);
    const byTaskId = Object.fromEntries(terminalResults.map((result) => [result.taskId, result]));
    record('cancel.sibling-isolation', byTaskId[dispatched[0].workItemId]?.status === 'cancelled'
      && ['done', 'unverified'].includes(byTaskId[dispatched[1].workItemId]?.status), { terminalResults });

    await page.screenshot({ path: path.join(scenarioDir, 'final.png'), fullPage: true });
    await page.locator('[data-testid="voice-end"]').click().catch(() => undefined);
    record('summary', true, {
      evidenceDir: OUT_DIR,
      sessionId,
      survivingSiblingNarrationId: survivingSiblingQuestion.narrationId,
      terminalResults,
    });
  } finally {
    if (originalExecutionModel !== undefined) {
      await setExecutionModel(page, originalExecutionModel).catch(() => undefined);
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
