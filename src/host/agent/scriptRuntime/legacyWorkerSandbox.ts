// Short-term compatibility only. Production callers must opt in explicitly.
import { Worker } from 'node:worker_threads';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { RpcRequest, RpcResponse } from './types';
import {
  restoreRunTraceContext,
  withRunTraceContext,
  type SerializedRunTraceContext,
} from '../../telemetry/runTraceContext';
import { getTelemetryService } from '../../telemetry/telemetryService';

const LEGACY_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
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
    let traceContext;
    if (workerData.traceContext) {
      const spanId = crypto.randomBytes(8).toString('hex');
      const flags = Number(workerData.traceContext.traceFlags || 0).toString(16).padStart(2, '0');
      traceContext = {
        ...workerData.traceContext,
        spanId,
        traceparent: '00-' + workerData.traceContext.traceId + '-' + spanId + '-' + flags,
      };
    }
    parentPort.postMessage({ __rpcRequest: true, id, kind, payload, traceContext });
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
  traceContext?: SerializedRunTraceContext;
}

export function runScriptInLegacyWorker(opts: LegacyWorkerOptions): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(LEGACY_SOURCE, {
      eval: true,
      workerData: {
        script: opts.script,
        goal: opts.goal,
        budgetTotal: opts.budgetTotal ?? null,
        traceContext: opts.traceContext,
      },
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
        const request = message as RpcRequest;
        let rpcPromise: Promise<RpcResponse>;
        let rpcSpanId: string | undefined;
        try {
          const restoredTraceContext = request.traceContext
            ? restoreRunTraceContext(request.traceContext)
            : undefined;
          if (restoredTraceContext) {
            try {
              rpcSpanId = getTelemetryService().startSpan(
                `workflow rpc:${request.kind}`,
                request.kind === 'agent' ? 'agent' : 'workflow',
                { 'workflow.rpc_kind': request.kind },
                opts.traceContext?.spanId,
                restoredTraceContext,
              ).spanId;
            } catch {
              // RPC execution is independent from tracing availability.
            }
          }
          rpcPromise = restoredTraceContext
            ? withRunTraceContext(restoredTraceContext, () => opts.onRpc(request))
            : opts.onRpc(request);
        } catch (error) {
          rpcPromise = Promise.reject(error);
        }
        void rpcPromise.then((response) => {
          try {
            if (rpcSpanId) getTelemetryService().endSpan(rpcSpanId, response.ok ? 'ok' : 'error');
          } catch {
            // RPC completion must not depend on tracing availability.
          }
          if (!settled) worker.postMessage({ __rpcResponse: true, ...response });
        }, (error) => {
          try {
            if (rpcSpanId) getTelemetryService().endSpan(rpcSpanId, 'error');
          } catch {
            // Preserve the original RPC error.
          }
          if (!settled) worker.postMessage({
            __rpcResponse: true,
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
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
