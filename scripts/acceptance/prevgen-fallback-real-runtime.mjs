#!/usr/bin/env node
// N-L7-PREVGEN-MUTE: one paid real-runtime call. Never retries a call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = arg('--url', 'http://127.0.0.1:8187');
const dataDir = arg('--data-dir', path.join(os.homedir(), '.code-agent-dev7'));
const outPath = arg('--out', path.join(os.tmpdir(), 'prevgen-fallback-real-runtime.json'));
const costAck = process.argv.includes('--cost-ack');
if (!costAck) throw new Error('Refusing paid voice call without --cost-ack');

const token = fs.readFileSync(path.join(dataDir, '.dev-token'), 'utf8').trim();
const startedAt = Date.now();
const evidence = {
  startedAt: new Date(startedAt).toISOString(),
  url,
  dataDir,
  assertions: {},
  textFrames: [],
  binary: { frames: 0, bytes: 0 },
};

async function domain(domainName, action, payload = {}) {
  const response = await fetch(`${url}/api/domain/${domainName}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload }),
  });
  const body = await response.json();
  if (!response.ok || body?.success === false) {
    throw new Error(`${domainName}:${action} failed: ${JSON.stringify(body)}`);
  }
  return body?.data ?? body;
}

function waitUntil(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 100);
  });
}

let ws;
let sessionId;
try {
  const health = await fetch(`${url}/api/health`).then((response) => response.json());
  evidence.health = {
    status: health.status,
    build: health.build,
    rendererServe: health.rendererServe,
  };

  const settings = await domain('settings', 'get');
  const live = settings.voice?.live;
  evidence.injectedSettings = live;
  evidence.assertions.injectedRetiredSelection = live?.conversationModel === 'qwen3-omni-flash-realtime'
    && live?.voiceId === 'Cherry';
  if (!evidence.assertions.injectedRetiredSelection) {
    throw new Error(`Expected retired model + Cherry, got ${JSON.stringify(live)}`);
  }

  const session = await domain('session', 'create', {
    title: 'N-L7-PREVGEN-MUTE-real-runtime',
    workingDirectory: process.cwd(),
  });
  sessionId = session.sessionId ?? session.id;
  if (!sessionId) throw new Error(`Session creation returned no id: ${JSON.stringify(session)}`);
  evidence.sessionId = sessionId;

  const wsUrl = new URL(url);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = '/api/voice/stream';
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', sessionId);
  ws = new WebSocket(wsUrl);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      evidence.binary.frames += 1;
      evidence.binary.bytes += data.length;
      return;
    }
    const raw = data.toString();
    try {
      evidence.textFrames.push(JSON.parse(raw));
    } catch {
      evidence.textFrames.push({ type: 'unparsed', length: raw.length });
    }
  });

  await waitUntil(
    () => evidence.textFrames.find((frame) => frame.type === 'notice' && frame.code === 'VOICE_CALL_SETTINGS_FALLBACK'),
    20_000,
    'fallback notice',
  );
  const fallback = evidence.textFrames.find((frame) => frame.type === 'notice' && frame.code === 'VOICE_CALL_SETTINGS_FALLBACK');
  evidence.assertions.fallbackNotice = fallback?.message === 'qwen3.5-omni-flash-realtime / Tina';

  await waitUntil(
    () => evidence.textFrames.some((frame) => frame.type === 'state' && frame.state === 'live'),
    20_000,
    'live state',
  );
  evidence.assertions.live = true;

  const injection = await domain('voice', 'injectUserText', {
    neoSessionId: sessionId,
    text: '请只用一句简短中文回应：回落验证成功。',
  });
  evidence.injection = injection;
  evidence.assertions.injection = injection.outcome === 'injected';
  if (!evidence.assertions.injection) throw new Error(`Text injection failed: ${JSON.stringify(injection)}`);

  await waitUntil(
    () => evidence.binary.bytes > 0
      && evidence.textFrames.some((frame) => frame.type === 'assistant.transcript' || frame.type === 'response.done'),
    45_000,
    'assistant audio and completion event',
  );
  evidence.assertions.assistantAudio = evidence.binary.bytes > 0;
  evidence.assertions.assistantEvent = evidence.textFrames.some(
    (frame) => frame.type === 'assistant.transcript' || frame.type === 'response.done',
  );
  evidence.passed = Object.values(evidence.assertions).every(Boolean);
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
  evidence.passed = false;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try { ws?.close(); } catch {}
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - startedAt;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    passed: evidence.passed,
    sessionId,
    assertions: evidence.assertions,
    binary: evidence.binary,
    durationMs: evidence.durationMs,
    outPath,
  }, null, 2)}\n`);
}

process.exitCode = evidence.passed ? 0 : 1;
