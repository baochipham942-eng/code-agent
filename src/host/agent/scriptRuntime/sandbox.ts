// ============================================================================
// sandbox —— 独立 Node 子进程运行模型生成的 orchestration script
//
// Host 与脚本不共享 JS runtime。子进程只通过 stdin/stdout 上的 framed IPC 获得
// agent/phase/log 三类请求能力；parallel/pipeline 在 child 内组合 Promise。默认启用
// Node permission model，macOS 再叠加 Seatbelt，child env 使用无凭据 allowlist。
// ============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import { redactSecrets } from '../../security/secretRedaction';
import { killProcessTree } from '../../tools/shell/platformShell';
import type { RpcRequest, RpcResponse } from './types';
import { runScriptInLegacyWorker } from './legacyWorkerSandbox';
import { ORCHESTRATION_CAPABILITIES } from './capabilityManifest';
import {
  restoreRunTraceContext,
  withRunTraceContext,
  type SerializedRunTraceContext,
} from '../../telemetry/runTraceContext';
import { getTelemetryService } from '../../telemetry/telemetryService';

const MAX_IPC_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const KILL_GRACE_MS = 500;

export const WORKER_SCRIPT_PARAMS = [
  'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget',
];

const PROCESS_SOURCE = String.raw`
'use strict';
const hostProcess = process;
const hostRequire = require;
const v8 = hostRequire('node:v8');
const hostCrypto = hostRequire('node:crypto');
const readline = hostRequire('node:readline');
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;
const pending = new Map();
let rpcSeq = 0;
let spent = 0;
let activeTraceContext;

function encode(value) { return v8.serialize(value).toString('base64'); }
function decode(value) { return v8.deserialize(Buffer.from(value, 'base64')); }
function send(value, callback) { hostProcess.stdout.write(encode(value) + '\n', callback); }
function childTraceContext() {
  if (!activeTraceContext) return undefined;
  const spanId = hostCrypto.randomBytes(8).toString('hex');
  const flags = Number(activeTraceContext.traceFlags || 0).toString(16).padStart(2, '0');
  return Object.freeze({
    ...activeTraceContext,
    spanId,
    traceparent: '00-' + activeTraceContext.traceId + '-' + spanId + '-' + flags,
  });
}
function hideAmbientAuthority() {
  const blocked = [
    'process', 'require', 'module', 'exports', '__dirname', '__filename', 'global',
    'globalThis', 'eval', 'Function', 'AsyncFunction', 'fetch', 'WebSocket',
    'EventSource', 'console', 'Buffer', 'Deno', 'Bun',
  ];
  for (const key of blocked) {
    try { Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false }); }
    catch (_) { try { globalThis[key] = undefined; } catch (_) {} }
  }
}

function rpc(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', request: { id, kind, payload, traceContext: childTraceContext() } });
  });
}

async function execute(init) {
  if (!init.capabilities || Object.values(init.capabilities).some(Boolean)) {
    throw new Error('orchestration capability manifest must deny ambient authority');
  }
  const budgetTotal = init.budgetTotal;
  activeTraceContext = init.traceContext;
  const budget = Object.freeze({
    total: budgetTotal == null ? null : budgetTotal,
    spent: () => spent,
    remaining: () => budgetTotal == null ? Infinity : Math.max(0, budgetTotal - spent),
  });
  const agent = (prompt, options) => rpc('agent', { prompt, options });
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => {
    try { return Promise.resolve(thunk()).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }));
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      try { value = await stage(value, item, index); }
      catch (_) { return null; }
    }
    return value;
  }));
  const phase = (title) => rpc('phase', { title: String(title) });
  const log = (message) => rpc('log', { message: String(message) });
  hideAmbientAuthority();
  const fn = new AsyncFunctionCtor(${WORKER_SCRIPT_PARAMS.map((p) => JSON.stringify(p)).join(', ')}, '"use strict";\n' + init.script);
  return fn(
    agent, parallel, pipeline, phase, log, init.goal, budget
  );
}

let initialized = false;
const rl = readline.createInterface({ input: hostProcess.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let message;
  try { message = decode(line); }
  catch (_) { return; }
  if (message.type === 'init' && !initialized) {
    initialized = true;
    try {
      const result = await execute(message);
      send({ type: 'done', outcome: { ok: true, result } }, () => hostProcess.exit(0));
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      send({ type: 'done', outcome: { ok: false, error: text } }, () => hostProcess.exit(1));
    }
    return;
  }
  if (message.type === 'rpc-response') {
    const response = message.response;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (typeof response.spent === 'number') spent = response.spent;
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(response.error || 'rpc failed'));
  }
});
`;

export interface RunSandboxOptions {
  script: string;
  goal?: string;
  budgetTotal?: number | null;
  signal: AbortSignal;
  onRpc: (req: RpcRequest) => Promise<RpcResponse>;
  timeoutMs?: number;
  onProcessSpawn?: (pid: number) => void;
  /** 测试/受限宿主可显式关闭 OS wrapper；生产默认开启且不自动降级。 */
  useOsSandbox?: boolean;
  /** 短期兼容开关；只有显式 true 才允许回到旧 worker 路径。 */
  legacyWorkerFallback?: boolean;
  /** Allowlisted run trace metadata propagated in the init frame. */
  traceContext?: SerializedRunTraceContext;
}

export interface WorkerOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ChildMessage {
  type: 'rpc' | 'done';
  request?: RpcRequest;
  outcome?: WorkerOutcome;
}

function encodeMessage(value: unknown): string {
  return serialize(value).toString('base64');
}

function decodeMessage(line: string): ChildMessage {
  return deserialize(Buffer.from(line, 'base64')) as ChildMessage;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: '1' };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function spawnSandboxProcess(cwd: string, useOsSandbox: boolean): ChildProcessWithoutNullStreams {
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) {
    throw new Error('Node permission model unavailable; process sandbox refuses to run');
  }
  const nodeArgs = [
    '--permission',
    `--max-old-space-size=${SCRIPT_RUNTIME.WORKER_MAX_OLD_GEN_MB}`,
    '--input-type=commonjs',
    '--eval',
    PROCESS_SOURCE,
  ];
  if (useOsSandbox && process.platform === 'win32') {
    throw new Error('Windows OS process sandbox adapter unavailable; refusing unsandboxed orchestration');
  }
  const useSeatbelt = useOsSandbox && process.platform === 'darwin';
  const useBubblewrap = useOsSandbox && process.platform === 'linux';
  const command = useSeatbelt
    ? '/usr/bin/sandbox-exec'
    : useBubblewrap
      ? 'bwrap'
      : process.execPath;
  const args = useSeatbelt
    ? ['-p', '(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath "/dev"))', process.execPath, ...nodeArgs]
    : useBubblewrap
      ? [
          '--unshare-all', '--die-with-parent', '--new-session',
          '--ro-bind', '/', '/',
          '--chdir', cwd, '--', process.execPath, ...nodeArgs,
        ]
      : nodeArgs;
  return spawn(command, args, {
    cwd,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

/** 独立进程执行；默认不自动降级。 */
export function runScriptInSandbox(opts: RunSandboxOptions): Promise<WorkerOutcome> {
  if (opts.legacyWorkerFallback) {
    return runScriptInLegacyWorker(opts);
  }
  const timeoutMs = opts.timeoutMs ?? SCRIPT_RUNTIME.WORKER_TIMEOUT_MS;
  return new Promise<WorkerOutcome>((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'code-agent-workflow-process-'));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnSandboxProcess(cwd, opts.useOsSandbox !== false);
    } catch (error) {
      rmSync(cwd, { recursive: true, force: true });
      resolve({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
      return;
    }

    if (child.pid !== undefined) opts.onProcessSpawn?.(child.pid);
    let settled = false;
    let requestedOutcome: WorkerOutcome | undefined;
    let stderr = '';
    let stdoutBuffer = '';
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
      rmSync(cwd, { recursive: true, force: true });
    };
    const finalize = (outcome: WorkerOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const stopTree = (outcome: WorkerOutcome): void => {
      if (requestedOutcome) return;
      requestedOutcome = outcome;
      killProcessTree(child, 'SIGTERM', { posixGroupKill: process.platform !== 'win32' });
      killTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL', { posixGroupKill: process.platform !== 'win32' });
      }, KILL_GRACE_MS);
    };
    const onAbort = (): void => stopTree({ ok: false, error: 'run aborted' });
    const timeoutTimer = setTimeout(
      () => stopTree({ ok: false, error: `process sandbox 执行超时 ${timeoutMs}ms` }),
      timeoutMs,
    );

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString().slice(0, STDERR_LIMIT - stderr.length);
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      if (Buffer.byteLength(stdoutBuffer) > MAX_IPC_LINE_BYTES) {
        stopTree({ ok: false, error: 'process sandbox IPC frame exceeded limit' });
        return;
      }
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        try {
          const message = decodeMessage(line);
          if (message.type === 'rpc' && message.request) {
            const req = message.request;
            if (!['agent', 'phase', 'log'].includes(req.kind)) {
              child.stdin.write(`${encodeMessage({ type: 'rpc-response', response: { id: req.id, ok: false, error: 'unsupported primitive' } })}\n`);
            } else {
              const invokeRpc = () => opts.onRpc(req);
              let rpcPromise: Promise<RpcResponse>;
              let rpcSpanId: string | undefined;
              try {
                const restoredTraceContext = req.traceContext
                  ? restoreRunTraceContext(req.traceContext)
                  : undefined;
                if (restoredTraceContext) {
                  try {
                    rpcSpanId = getTelemetryService().startSpan(
                      `workflow rpc:${req.kind}`,
                      req.kind === 'agent' ? 'agent' : 'workflow',
                      { 'workflow.rpc_kind': req.kind },
                      opts.traceContext?.spanId,
                      restoredTraceContext,
                    ).spanId;
                  } catch {
                    // RPC execution is independent from tracing availability.
                  }
                }
                rpcPromise = restoredTraceContext
                  ? withRunTraceContext(restoredTraceContext, invokeRpc)
                  : invokeRpc();
              } catch (error) {
                rpcPromise = Promise.reject(error);
              }
              void rpcPromise.then(
                (response) => {
                  try {
                    if (rpcSpanId) getTelemetryService().endSpan(rpcSpanId, response.ok ? 'ok' : 'error');
                  } catch {
                    // RPC completion must not depend on tracing availability.
                  }
                  child.stdin.write(`${encodeMessage({ type: 'rpc-response', response })}\n`);
                },
                (error) => {
                  try {
                    if (rpcSpanId) getTelemetryService().endSpan(rpcSpanId, 'error');
                  } catch {
                    // Preserve the original RPC error.
                  }
                  child.stdin.write(`${encodeMessage({
                    type: 'rpc-response',
                    response: { id: req.id, ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) },
                  })}\n`);
                },
              );
            }
          } else if (message.type === 'done' && message.outcome) {
            stopTree(message.outcome);
          }
        } catch {
          stopTree({ ok: false, error: 'invalid process sandbox IPC frame' });
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.on('error', (error) => finalize({ ok: false, error: redactSecrets(error.message) }));
    child.on('close', (code) => {
      if (requestedOutcome) {
        finalize(requestedOutcome);
      } else {
        const detail = redactSecrets(stderr.trim());
        finalize({ ok: false, error: detail || `process sandbox 退出码 ${code ?? -1}` });
      }
    });

    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdin.write(`${encodeMessage({
      type: 'init',
      script: opts.script,
      goal: opts.goal,
      budgetTotal: opts.budgetTotal ?? null,
      capabilities: ORCHESTRATION_CAPABILITIES,
      traceContext: opts.traceContext,
    })}\n`);
  });
}

/** 旧 importer 兼容；实现已经是 child process。 */
export const runScriptInWorker = runScriptInSandbox;
