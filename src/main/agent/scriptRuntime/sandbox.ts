// ============================================================================
// sandbox —— worker_threads 沙箱：跑模型写的不可信编排脚本
//
// 用 new Worker(code, { eval: true }) 而非单独 bundle 文件：worker 源码作为字符串常量随
// webServer.cjs 一起被 esbuild 打包，无独立产物文件、无打包路径解析（规避艾克斯警告的打包
// 陷阱），打包态/headless 态自动可用。
//
// 安全边界（MVP）：worker 提供线程级隔离 + 内存上限 + 超时 terminate。脚本经 new AsyncFunction
// 执行，作用域内 require/process/module/__dirname 被 shadow 成 undefined（拿不到 fs/net 模块）。
// 重活（model/DB/网络）全在主线程，worker 只能经 5 个 RPC 原语触达受控接口。注：globalThis 仍可
// 经 (0,eval)('this') 等旁路触达——脚本是模型生成的半信任代码，非对抗性攻击者；强隔离（isolated-vm）
// 留后续。worker 崩溃/失控由 terminate + 内存上限兜底，不影响 webServer 主进程。
// ============================================================================

import { Worker } from 'node:worker_threads';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { RpcRequest, RpcResponse } from './types';

// worker 线程内执行的源码（纯 JS 字符串）。注入 5 原语为 RPC stub；parallel/pipeline 在此处用
// Promise 组合（无栅栏 pipeline：每 item 独立流过所有 stage）；脚本经 new AsyncFunction 运行。
export const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { script, goal, budgetTotal } = workerData;

let rpcSeq = 0;
const pending = new Map();

// budget 只读镜像：total 在 worker 启动时固定；spent 随 agent RPC 响应回传更新（主线程权威）。
let _spent = 0;
const budget = {
  total: (budgetTotal === undefined ? null : budgetTotal),
  spent: () => _spent,
  remaining: () => (budgetTotal === undefined || budgetTotal === null) ? Infinity : Math.max(0, budgetTotal - _spent),
};

parentPort.on('message', (msg) => {
  if (msg && msg.__rpcResponse) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (typeof msg.spent === 'number') _spent = msg.spent;
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'rpc failed'));
    }
  }
});

function rpc(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ __rpcRequest: true, id, kind, payload });
  });
}

const agent = (prompt, options) => rpc('agent', { prompt, options });

// 栅栏：等全部完成。thunk 抛错 → 该项 resolve 成 null（对齐 Claude Code Workflow，调用方 .filter(Boolean)）。
const parallel = (thunks) => Promise.all(
  thunks.map((t) => {
    try { return Promise.resolve(t()).catch(() => null); }
    catch (e) { return Promise.resolve(null); }
  })
);

// 无栅栏：每 item 独立流过所有 stage，A 在 stage3 时 B 还能在 stage1。stage 抛错 → 该 item drop 成 null。
const pipeline = (items, ...stages) => Promise.all(
  items.map(async (item, idx) => {
    let acc = item;
    for (const stage of stages) {
      try { acc = await stage(acc, item, idx); }
      catch (e) { return null; }
    }
    return acc;
  })
);

const phase = (title) => rpc('phase', { title: String(title) });
const log = (message) => rpc('log', { message: String(message) });
const args = goal;

(async () => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // shadow 危险全局：把它们作为形参传 undefined，脚本作用域内拿不到 require/fs/process。
    const fn = new AsyncFunction(
      'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget',
      'require', 'process', 'module', 'exports', '__dirname', '__filename', 'global', 'globalThis',
      script
    );
    const result = await fn(
      agent, parallel, pipeline, phase, log, args, budget,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined
    );
    parentPort.postMessage({ __workerDone: true, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ __workerDone: true, ok: false, error: (err && err.message) ? err.message : String(err) });
  }
})();
`;

export interface RunWorkerOptions {
  script: string;
  goal?: string;
  /** token 预算上限（outputTokens），透传给 worker 的 budget.total/remaining 镜像。null = 不设限。 */
  budgetTotal?: number | null;
  signal: AbortSignal;
  /** 处理 worker 发来的 RPC 请求（agent/phase/log）。 */
  onRpc: (req: RpcRequest) => Promise<RpcResponse>;
  timeoutMs?: number;
}

export interface WorkerOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RpcRequestMessage {
  __rpcRequest: true;
  id: number;
  kind: RpcRequest['kind'];
  payload: RpcRequest['payload'];
}

interface WorkerDoneMessage {
  __workerDone: true;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * 在受限 worker 里跑一段编排脚本，泵送 RPC 直到脚本 return（done）或超时/abort/崩溃。
 * 永不 reject——结果统一打进 WorkerOutcome。
 */
export function runScriptInWorker(opts: RunWorkerOptions): Promise<WorkerOutcome> {
  const timeoutMs = opts.timeoutMs ?? SCRIPT_RUNTIME.WORKER_TIMEOUT_MS;
  return new Promise<WorkerOutcome>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { script: opts.script, goal: opts.goal, budgetTotal: opts.budgetTotal ?? null },
      resourceLimits: { maxOldGenerationSizeMb: SCRIPT_RUNTIME.WORKER_MAX_OLD_GEN_MB },
    });

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      void worker.terminate();
    };
    const finish = (outcome: WorkerOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ ok: false, error: `worker 执行超时 ${timeoutMs}ms` }), timeoutMs);
    const onAbort = (): void => finish({ ok: false, error: 'run aborted' });
    if (opts.signal.aborted) {
      finish({ ok: false, error: 'run aborted' });
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg: RpcRequestMessage | WorkerDoneMessage) => {
      if (msg && (msg as RpcRequestMessage).__rpcRequest) {
        const req = msg as RpcRequestMessage;
        void opts
          .onRpc({ id: req.id, kind: req.kind, payload: req.payload })
          .then((res) => {
            if (!settled) worker.postMessage({ __rpcResponse: true, ...res });
          });
      } else if (msg && (msg as WorkerDoneMessage).__workerDone) {
        const done = msg as WorkerDoneMessage;
        finish({ ok: done.ok, result: done.result, error: done.error });
      }
    });
    worker.on('error', (err: unknown) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    worker.on('exit', (code) => {
      if (code !== 0) finish({ ok: false, error: `worker 退出码 ${code}` });
    });
  });
}
