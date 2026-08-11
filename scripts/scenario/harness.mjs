import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const worktreePackage = path.join(process.cwd(), 'package.json');
function mainRepoPackage() {
  // worktree 里没装依赖时退回主仓的 node_modules（git common-dir 的上一级即主仓根）
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  return path.join(path.dirname(path.resolve(process.cwd(), commonDir)), 'package.json');
}
const installedPackage = fs.existsSync(path.join(process.cwd(), 'node_modules', 'ws'))
  ? worktreePackage
  : mainRepoPackage();
const require = createRequire(installedPackage);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NotRun extends Error {
  constructor(reason, evidence) {
    super(reason);
    this.name = 'NotRun';
    this.reason = reason;
    this.evidence = evidence;
  }
}

export function resolveEnv({ slot }) {
  const resolvedSlot = Number.isInteger(slot) && slot > 0
    ? slot
    : Number.parseInt(process.env.NEO_SLOT || '1', 10) || 1;
  // Keep this copied source-of-truth formula literal; see docs/plans/2026-08-11-L10剧本runner-设计草案.md §2.1.
  const port = Number.parseInt(process.env.CODE_AGENT_WEB_PORT || '', 10) || 8180 + resolvedSlot;
  const homeDir = os.homedir();
  const dataDir = path.join(homeDir, resolvedSlot === 1 ? '.code-agent-dev' : `.code-agent-dev${resolvedSlot}`);
  const tokenPath = path.join(dataDir, '.dev-token');
  const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : null;
  return {
    slot: resolvedSlot,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    homeDir,
    dataDir,
    dbPath: path.join(dataDir, 'code-agent.db'),
    tokenPath,
    token,
  };
}

export function createApi(env) {
  const headers = {
    Authorization: `Bearer ${env.token || ''}`,
    'Content-Type': 'application/json',
  };
  async function read(response) {
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  }
  return {
    async post(route, payload) {
      return read(await fetch(env.baseUrl + route, {
        method: 'POST', headers, body: JSON.stringify({ payload }),
      }));
    },
    async get(route) {
      return read(await fetch(env.baseUrl + route, { headers }));
    },
  };
}

function git(args) {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
}

function persistencePath(health) {
  const persistence = health?.persistence;
  if (!persistence || typeof persistence !== 'object') return null;
  for (const key of ['path', 'dataDir', 'dbPath', 'databasePath']) {
    if (typeof persistence[key] === 'string') return persistence[key];
  }
  return null;
}

export async function assertEnv(env, { requireCommit } = {}) {
  const api = createApi(env);
  let probe;
  try {
    probe = await api.get('/api/health');
  } catch (error) {
    throw new NotRun('cannot_connect', {
      message: error instanceof Error ? error.message : String(error),
      baseUrl: env.baseUrl,
      tokenPresent: Boolean(env.token),
    });
  }
  const health = probe.body;
  if (probe.status < 200 || probe.status >= 300 || !health || health.status !== 'ok') {
    throw new NotRun('cannot_connect', { probe, baseUrl: env.baseUrl });
  }

  const localHead = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const actualCommit = health?.build?.commitShort;
  const actualPersistencePath = persistencePath(health);
  const baseEvidence = {
    health,
    localHead,
    dirty,
    expectedDataDir: env.dataDir,
    persistencePath: actualPersistencePath,
    rebuildHint: 'Build with npm run tauri:build:dev, then start the Dev app from a terminal with nohup so it inherits DASHSCOPE_API_KEY and related environment variables.',
  };
  if (health?.rendererServe?.source !== 'builtin') {
    throw new NotRun('stale_build', { ...baseEvidence, mismatch: 'renderer_not_builtin' });
  }
  if (!actualPersistencePath || !path.resolve(actualPersistencePath).startsWith(`${path.resolve(env.dataDir)}${path.sep}`)
    && path.resolve(actualPersistencePath || '') !== path.resolve(env.dataDir)) {
    throw new NotRun('stale_build', { ...baseEvidence, mismatch: 'persistence_path' });
  }
  if (dirty) {
    throw new NotRun('stale_build', { ...baseEvidence, mismatch: 'local_worktree_dirty' });
  }
  if (!actualCommit || typeof actualCommit !== 'string') {
    throw new NotRun('stale_build', { ...baseEvidence, mismatch: 'missing_build_commit' });
  }
  if (requireCommit) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', requireCommit, actualCommit], { cwd: process.cwd() });
    } catch {
      throw new NotRun('stale_build', { ...baseEvidence, requireCommit, mismatch: 'required_commit_not_ancestor' });
    }
  } else if (actualCommit !== localHead) {
    throw new NotRun('stale_build', { ...baseEvidence, mismatch: 'build_commit_not_local_head' });
  }
  return { api, health, localHead, dirty };
}

export function openEvents(env, logPath) {
  const controller = new AbortController();
  const events = [];
  const rawEvents = [];
  const state = { connected: false, receivedCount: 0, error: null };
  fs.writeFileSync(logPath, '');
  const done = (async () => {
    const response = await fetch(`${env.baseUrl}/api/events?token=${encodeURIComponent(env.token || '')}`, {
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    state.connected = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const raw = JSON.parse(line.slice(5).trim());
          rawEvents.push(raw);
          fs.appendFileSync(logPath, `${JSON.stringify(raw)}\n`);
          const event = raw?.channel === 'agent:event' ? raw.args : null;
          if (event && typeof event === 'object') {
            events.push(event);
            state.receivedCount += 1;
          }
        } catch {
          // Malformed SSE frames are preserved only when valid JSON; they cannot prove a product verdict.
        }
      }
    }
  })().catch((error) => {
    if (error?.name !== 'AbortError') state.error = error instanceof Error ? error.message : String(error);
  });
  return {
    events,
    rawEvents,
    state,
    logPath,
    async waitFor(pred, timeoutMs) {
      const started = Date.now();
      let cursor = 0;
      while (Date.now() - started < timeoutMs) {
        while (cursor < events.length) {
          const event = events[cursor++];
          if (pred(event, events)) return event;
        }
        await sleep(250);
      }
      return null;
    },
    stop() { controller.abort(); },
    done,
  };
}

function nonEmptyEvidence(evidence) {
  if (evidence === null || evidence === undefined) return false;
  if (typeof evidence === 'string') return evidence.trim().length > 0;
  if (Array.isArray(evidence)) return evidence.length > 0;
  return typeof evidence !== 'object' || Object.keys(evidence).length > 0;
}

function sessionIdFrom(response) {
  return response?.body?.data?.sessionId || response?.body?.sessionId || response?.body?.data?.id || null;
}

function knownVoiceNotRun(error) {
  const code = String(error?.code || error?.reason || '').toUpperCase();
  if (code.includes('VOICE_PROVIDER_UNCONFIGURED')) return 'VOICE_PROVIDER_UNCONFIGURED';
  if (code.includes('VOICE_SESSION_BUSY')) return 'VOICE_SESSION_BUSY';
  return null;
}

function parseFrames(frames) {
  return frames.map((frame) => {
    try { return JSON.parse(frame); } catch { return null; }
  }).filter(Boolean);
}

export function createLegContext({ env, api, outDir, scenario, legName }) {
  const assertions = [];
  const cleanups = [];
  const streams = [];
  const voiceCalls = [];
  const dbs = [];
  const startedAt = Date.now();
  const ctx = {
    env,
    api,
    scenario,
    legName,
    assertions,
    startedAt,
    expect(name, ok, evidence) {
      assertions.push({ kind: 'expect', name, ok: Boolean(ok), evidence, evidenceValid: nonEmptyEvidence(evidence) });
    },
    expectAbsent(name, found, evidence) {
      assertions.push({ kind: 'expectAbsent', name, ok: !found, found: Boolean(found), evidence, evidenceValid: nonEmptyEvidence(evidence) });
    },
    notRun(reason, evidence) { throw new NotRun(reason, evidence); },
    cleanup(fn, label) { cleanups.push({ fn, label }); },
    tmpFile(directory) {
      const filePath = path.join(directory, `boundary_probe_${crypto.randomBytes(4).toString('hex')}.txt`);
      cleanups.push({ label: `delete ${filePath}`, fn: () => fs.rmSync(filePath, { force: true }) });
      return filePath;
    },
    async createSession(workingDirectory) {
      const response = await api.post('/api/domain/session/create', { title: `scenario-${scenario.id}-${legName}`, workingDirectory });
      const sessionId = sessionIdFrom(response);
      if (!sessionId) ctx.notRun('session_create_failed', response);
      return sessionId;
    },
    openEvents() {
      const stream = openEvents(env, path.join(outDir, `${legName}.sse.jsonl`));
      streams.push(stream);
      cleanups.push({ label: 'close SSE', fn: () => stream.stop() });
      return stream;
    },
    async waitUntil(pred, timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (pred()) return true;
        await sleep(250);
      }
      return false;
    },
    db: {
      query(sql, params = []) {
        let db = dbs[0];
        if (!db) {
          try {
          const Database = require('better-sqlite3');
          db = new Database(env.dbPath, { readonly: true });
          } catch (error) {
            ctx.notRun('db_unavailable', { dbPath: env.dbPath, message: error instanceof Error ? error.message : String(error) });
          }
          dbs.push(db);
          cleanups.push({ label: 'close DB', fn: () => db.close() });
        }
        return db.prepare(sql).all(...params);
      },
      permissionDecisions({ since, until }) {
        return {
          lossy: true,
          rows: this.query(`SELECT * FROM permission_decisions WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at ASC, id ASC`, [since, until]),
        };
      },
    },
    voice: {
      async connect(sessionId) {
        const logPath = path.join(outDir, `${legName}.voice.jsonl`);
        fs.writeFileSync(logPath, '');
        const WebSocket = require('ws');
        const ws = new WebSocket(`ws://127.0.0.1:${env.port}/api/voice/stream?token=${encodeURIComponent(env.token || '')}&sessionId=${encodeURIComponent(sessionId)}`);
        const frames = [];
        const call = { ws, frames, logPath, startedAt: Date.now(), endedAt: null, ended: false };
        voiceCalls.push(call);
        ws.on('message', (data) => {
          const frame = data.toString();
          frames.push(frame);
          fs.appendFileSync(logPath, `${frame}\n`);
        });
        const end = async () => {
          if (call.ended) return true;
          call.ended = true;
          try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' })); } catch {}
          await sleep(1500);
          try { ws.close(); } catch {}
          for (let i = 0; i < 15; i += 1) {
            try {
              const status = await api.get('/api/voice/status');
              if (!status.body?.active && !status.body?.data?.active) {
                call.endedAt = Date.now();
                return true;
              }
            } catch {}
            await sleep(2000);
          }
          call.endedAt = Date.now();
          return false;
        };
        cleanups.push({ label: 'end voice call and verify voice/status', fn: end });
        const waitLive = async (timeoutMs) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const parsed = parseFrames(frames);
            const error = parsed.find((frame) => frame?.type === 'error');
            if (error) throw new NotRun(knownVoiceNotRun(error) || error.code || 'ws_error', error);
            if (parsed.some((frame) => frame?.type === 'state' && frame?.state === 'live') || frames.some((frame) => frame.includes('"state":"live"'))) return true;
            if (ws.readyState === WebSocket.CLOSED) break;
            await sleep(250);
          }
          throw new NotRun('no_live_state', { frames: frames.slice(0, 5) });
        };
        const injectText = async (text) => {
          let response;
          for (let i = 0; i < 6; i += 1) {
            response = await api.post('/api/domain/voice/injectUserText', { neoSessionId: sessionId, text });
            const outcome = response.body?.data?.outcome || response.body?.outcome;
            if (outcome !== 'fallback') return response;
            if (i < 5) await sleep(2500);
          }
          throw new NotRun('inject_fallback', response?.body);
        };
        return { frames, logPath, waitLive, injectText, end };
      },
    },
    async finish() {
      const cleanupResults = [];
      let teardownClean = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          const result = await cleanup.fn();
          if (result === false) teardownClean = false;
          cleanupResults.push({ label: cleanup.label, ok: result !== false });
        } catch (error) {
          teardownClean = false;
          cleanupResults.push({ label: cleanup.label, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        teardownClean,
        cleanupResults,
        streams: streams.map((stream) => ({ logPath: stream.logPath, ...stream.state })),
        voiceDurationMs: voiceCalls.reduce((sum, call) => sum + ((call.endedAt || Date.now()) - call.startedAt), 0),
      };
    },
  };
  return ctx;
}

export function validateLeg({ legName, assertions, openedEvents }) {
  const invalid = [];
  if (!assertions.some((assertion) => assertion.kind === 'expectAbsent')) invalid.push(`${legName}: missing expectAbsent`);
  for (const assertion of assertions) {
    if (!assertion.evidenceValid) invalid.push(`${legName}: ${assertion.name} has empty evidence`);
  }
  if (assertions.some((assertion) => /permission/i.test(assertion.name)) && openedEvents === 0) {
    invalid.push(`${legName}: permission assertion requires openEvents()`);
  }
  return invalid;
}
