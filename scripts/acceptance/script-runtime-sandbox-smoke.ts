// ============================================================================
// scriptRuntime 沙箱骨架验收（零 token）
//
// 用 mock onRpc 跑一段含 phase/log/parallel/pipeline/错误处理/args/return 的编排脚本，
// 验证 worker eval 沙箱 + RPC 双向 + 5 原语 + 栅栏/无栅栏语义。不触达真模型。
//
// 本地跑（worktree 无 tsx/jiti 时）：
//   node_modules/.bin/esbuild scripts/acceptance/script-runtime-sandbox-smoke.ts \
//     --bundle --platform=node --format=cjs --outfile=/tmp/srs.cjs && node /tmp/srs.cjs
// CI/约定：npx tsx scripts/acceptance/script-runtime-sandbox-smoke.ts
// ============================================================================

import { runScriptInWorker } from '../../src/host/agent/scriptRuntime/sandbox';
import type { RpcRequest, RpcResponse } from '../../src/host/agent/scriptRuntime/types';

const script = `
  await phase('research');
  await log('starting smoke run');
  const budgetBefore = { total: budget.total, spent: budget.spent(), remaining: budget.remaining() };
  const items = ['a', 'b', 'c'];
  const results = await parallel(items.map((x) => () => agent('echo:' + x)));
  const piped = await pipeline([1, 2], (s) => agent('s1:' + s), (s) => agent('s2:' + s));
  const withFailure = await parallel([() => { throw new Error('boom'); }, () => agent('ok')]);
  const budgetAfter = { total: budget.total, spent: budget.spent(), remaining: budget.remaining() };
  return { results, piped, withFailure, goal: args, budgetBefore, budgetAfter };
`;

async function main(): Promise<void> {
  const rpcLog: string[] = [];
  const outcome = await runScriptInWorker({
    script,
    goal: 'smoke-goal',
    budgetTotal: 100,
    signal: new AbortController().signal,
    onRpc: async (req: RpcRequest): Promise<RpcResponse> => {
      rpcLog.push(req.kind);
      if (req.kind === 'agent') {
        const prompt = (req.payload as { prompt: string }).prompt;
        // 固定 spent=42 回传，验证 worker budget 镜像被 RPC 响应更新（与并发顺序无关）。
        return { id: req.id, ok: true, result: `R[${prompt}]`, spent: 42 };
      }
      return { id: req.id, ok: true, result: null };
    },
  });
  console.log('=== outcome ===');
  console.log(JSON.stringify(outcome, null, 2));
  console.log('=== rpc kinds ===', rpcLog.join(', '));

  const r = outcome.result as Record<string, unknown> | undefined;
  const before = r?.budgetBefore as { total: number; spent: number; remaining: number } | undefined;
  const after = r?.budgetAfter as { total: number; spent: number; remaining: number } | undefined;
  const ok =
    outcome.ok === true &&
    JSON.stringify(r?.results) === JSON.stringify(['R[echo:a]', 'R[echo:b]', 'R[echo:c]']) &&
    JSON.stringify(r?.piped) === JSON.stringify(['R[s2:R[s1:1]]', 'R[s2:R[s1:2]]']) &&
    JSON.stringify(r?.withFailure) === JSON.stringify([null, 'R[ok]']) &&
    r?.goal === 'smoke-goal' &&
    // budget：total 透传、初始 spent 0、agent RPC 后镜像更新为 42、remaining 同步
    before?.total === 100 && before?.spent === 0 && before?.remaining === 100 &&
    after?.total === 100 && after?.spent === 42 && after?.remaining === 58;
  console.log('=== budget ===', JSON.stringify({ before, after }));
  console.log('=== ASSERT ===', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

void main();
