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

import { runScriptInWorker } from '../../src/main/agent/scriptRuntime/sandbox';
import type { RpcRequest, RpcResponse } from '../../src/main/agent/scriptRuntime/types';

const script = `
  await phase('research');
  await log('starting smoke run');
  const items = ['a', 'b', 'c'];
  const results = await parallel(items.map((x) => () => agent('echo:' + x)));
  const piped = await pipeline([1, 2], (s) => agent('s1:' + s), (s) => agent('s2:' + s));
  const withFailure = await parallel([() => { throw new Error('boom'); }, () => agent('ok')]);
  return { results, piped, withFailure, goal: args };
`;

async function main(): Promise<void> {
  const rpcLog: string[] = [];
  const outcome = await runScriptInWorker({
    script,
    goal: 'smoke-goal',
    signal: new AbortController().signal,
    onRpc: async (req: RpcRequest): Promise<RpcResponse> => {
      rpcLog.push(req.kind);
      if (req.kind === 'agent') {
        const prompt = (req.payload as { prompt: string }).prompt;
        return { id: req.id, ok: true, result: `R[${prompt}]` };
      }
      return { id: req.id, ok: true, result: null };
    },
  });
  console.log('=== outcome ===');
  console.log(JSON.stringify(outcome, null, 2));
  console.log('=== rpc kinds ===', rpcLog.join(', '));

  const r = outcome.result as Record<string, unknown> | undefined;
  const ok =
    outcome.ok === true &&
    JSON.stringify(r?.results) === JSON.stringify(['R[echo:a]', 'R[echo:b]', 'R[echo:c]']) &&
    JSON.stringify(r?.piped) === JSON.stringify(['R[s2:R[s1:1]]', 'R[s2:R[s1:2]]']) &&
    JSON.stringify(r?.withFailure) === JSON.stringify([null, 'R[ok]']) &&
    r?.goal === 'smoke-goal';
  console.log('=== ASSERT ===', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

void main();
