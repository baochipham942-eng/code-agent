// ============================================================================
// dynamic-workflow P2-B E2E —— 真模型(mimo)验证 token budget 硬上限 + worker remaining()
//
// 两段：
//   ① 动态收敛：脚本用 while(budget.remaining() > x) 自限扇出，budget 真按 outputTokens 累加、
//      worker 侧 budget.remaining() 反映真实消耗、循环被预算（而非 n 上限）截停。
//   ② 硬上限：runaway 脚本忽略预算狂发，超限后 agent() 抛错 → run 失败、error 提及 budget。
//
// 跑法（worktree 无 tsx）：
//   node_modules/.bin/esbuild scripts/acceptance/script-runtime-budget-e2e.ts \
//     --bundle --platform=node --format=cjs --packages=external --outfile=.wf-budget.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .wf-budget.cjs && rm .wf-budget.cjs
// 注意：mimo 直连，**不要**设 HTTPS_PROXY。
// ============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfig } from '../../src/shared/contract';
import type { ToolContext } from '../../src/main/protocol/tools';
import { workflowModule } from '../../src/main/tools/modules/multiagent/workflow';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(join(homedir(), '.code-agent', '.env'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function buildMockCtx(modelConfig: ModelConfig): ToolContext {
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: (m: string, meta?: unknown) => console.error('[error]', m, meta ?? '') };
  return {
    sessionId: 'e2e-budget',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger,
    currentToolCallId: 'e2e-budget-1',
    emit: () => {},
    modelConfig,
  } as unknown as ToolContext;
}

// ① 动态收敛：budget.remaining() 自限扇出。
const SCALE_SCRIPT = `
phase('scale');
let n = 0;
const facts = [];
while (budget.remaining() > 80 && n < 25) {
  const r = await agent('State one short, distinct fact about the integer ' + n + '. One sentence.',
    { label: 'fact-' + n, schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } });
  facts.push(r.fact);
  n++;
}
return { ran: n, total: budget.total, spent: budget.spent(), remaining: budget.remaining() };
`;

// ② 硬上限：忽略预算狂发，超限后 agent() 抛错。用 ① 已证可靠的 short-fact prompt 让首调稳定
// （避开 mimo forced 偶发"未返回 tool call"），预算极小 → 首调消耗即超限 → 次调命中硬上限。
const RUNAWAY_SCRIPT = `
phase('runaway');
let n = 0;
while (n < 25) {
  await agent('State one short, distinct fact about the integer ' + n + '. One sentence.',
    { label: 'r-' + n, schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } });
  n++;
}
return { n };
`;

async function main(): Promise<void> {
  const env = loadEnv();
  const apiKey = env.XIAOMI_API_KEY;
  const baseUrl = env.XIAOMI_API_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
  if (!apiKey) throw new Error('XIAOMI_API_KEY not found in ~/.code-agent/.env');
  process.env.XIAOMI_API_KEY = apiKey;
  process.env.XIAOMI_API_URL = baseUrl;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;

  const modelConfig: ModelConfig = {
    provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey, baseUrl,
    temperature: 0.3, maxTokens: 2048, reasoningEffort: 'low',
  };
  const ctx = buildMockCtx(modelConfig);
  const handler = await workflowModule.createHandler();
  const canUseTool = async () => ({ allow: true });

  // ── ① 动态收敛 ──────────────────────────────────────────────────────────────
  console.log('=== ① dynamic scaling (budgetTokens=200) ===');
  const t0 = Date.now();
  const r1 = await handler.execute(
    { script: SCALE_SCRIPT, goal: 'scaling probe', budgetTokens: 200 },
    ctx, canUseTool as never, () => {},
  );
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s) ok=${r1.ok} meta=${JSON.stringify(r1.meta)}`);
  if (r1.ok) console.log('  output:', r1.output);
  const out1 = r1.ok ? JSON.parse(r1.output) : {};
  const metaSpent1 = (r1.meta as { tokensSpent?: number })?.tokensSpent;
  const scalePass =
    r1.ok === true &&
    out1.total === 200 &&
    out1.ran >= 1 && out1.ran < 25 &&          // 被预算截停，不是撞 n 上限
    out1.spent > 0 && out1.remaining <= 80 &&  // worker remaining() 反映真实消耗
    metaSpent1 === out1.spent;                  // meta.tokensSpent 与 worker 镜像一致

  // ── ② 硬上限抛错 ────────────────────────────────────────────────────────────
  console.log('\n=== ② hard ceiling (budgetTokens=20, runaway) ===');
  const t1 = Date.now();
  const r2 = await handler.execute(
    { script: RUNAWAY_SCRIPT, goal: 'runaway', budgetTokens: 20 },
    ctx, canUseTool as never, () => {},
  );
  console.log(`  (${((Date.now() - t1) / 1000).toFixed(1)}s) ok=${r2.ok} error=${r2.ok ? '' : r2.error} meta=${JSON.stringify(r2.meta)}`);
  const ceilingPass =
    r2.ok === false &&
    /budget|耗尽/.test(r2.error ?? '');

  const pass = scalePass && ceilingPass;
  console.log('\n=== ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  ① scale: ran=' + out1.ran + ' spent=' + out1.spent + ' remaining=' + out1.remaining + ' metaSpent=' + metaSpent1 + ' →', scalePass);
  console.log('  ② ceiling: ok=false & budget error →', ceilingPass);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
