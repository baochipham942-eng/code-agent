// Short-term compatibility only. Production callers must opt in explicitly.
import { Worker } from 'node:worker_threads';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { RpcRequest, RpcResponse } from './types';

const LEGACY_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let seq = 0;
let spent = 0;
const pending = new Map();
parentPort.on('message', (message) => {
  if (!message || !message.__rpcResponse) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (typeof message.spent === 'number') spent = message.spent;
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error || 'rpc failed'));
});
function rpc(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ __rpcRequest: true, id, kind, payload });
  });
}
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
const budget = Object.freeze({
  total: workerData.budgetTotal == null ? null : workerData.budgetTotal,
  spent: () => spent,
  remaining: () => workerData.budgetTotal == null ? Infinity : Math.max(0, workerData.budgetTotal - spent),
});
(async () => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'require', 'process', 'globalThis', workerData.script);
    const result = await fn(agent, parallel, pipeline, phase, log, workerData.goal, budget, undefined, undefined, undefined);
    parentPort.postMessage({ __workerDone: true, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ __workerDone: true, ok: false, error: error && error.message ? error.message : String(error) });
  }
})();
`;

export interface LegacyWorkerOptions {
  script: string;
  goal?: string;
  budgetTotal?: number | null;
  signal: AbortSignal;
  onRpc: (request: RpcRequest) => Promise<RpcResponse>;
  timeoutMs?: number;
}

export function runScriptInLegacyWorker(opts: LegacyWorkerOptions): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(LEGACY_SOURCE, {
      eval: true,
      workerData: { script: opts.script, goal: opts.goal, budgetTotal: opts.budgetTotal ?? null },
      resourceLimits: { maxOldGenerationSizeMb: SCRIPT_RUNTIME.WORKER_MAX_OLD_GEN_MB },
    });
    let settled = false;
    const finish = (outcome: { ok: boolean; result?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      resolve(outcome);
    };
    const onAbort = () => finish({ ok: false, error: 'run aborted' });
    const timer = setTimeout(
      () => finish({ ok: false, error: 'legacy worker execution timed out' }),
      opts.timeoutMs ?? SCRIPT_RUNTIME.WORKER_TIMEOUT_MS,
    );
    if (opts.signal.aborted) return onAbort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message) => {
      if (message?.__rpcRequest) {
        void opts.onRpc(message as RpcRequest).then((response) => {
          if (!settled) worker.postMessage({ __rpcResponse: true, ...response });
        });
      } else if (message?.__workerDone) {
        finish({ ok: message.ok, result: message.result, error: message.error });
      }
    });
    worker.on('error', (error: unknown) => finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    worker.on('exit', (code) => {
      if (code !== 0) finish({ ok: false, error: `legacy worker exited ${code}` });
    });
  });
}
