// ============================================================================
// dynamic-workflow resumable E2E（P4-E，真 mimo + 真 SQLite journal）
//
// 全链路验 resume：真 workflowModule handler → startRun → 真 WorkflowJournalRepository
// (SQLite) → worker → mimo forced。
//   run1：真 mimo 跑（写 journal，拿 runId + tokensSpent）。
//   run2：同脚本 + resumeFromRunId → 全缓存命中（0 mimo / 0 token），结果与 run1 逐字一致。
//
// standalone 无 Electron app → DatabaseService 用 process.cwd() 建库；脚本先 chdir 到临时目录，
// 让 code-agent.db 落临时处，绝不污染真实用户库。同进程两次 handler 调用共享该库 → journal 持久。
//
// 跑法（worktree 无 tsx）：
//   node_modules/.bin/esbuild scripts/acceptance/script-runtime-resume-e2e.ts \
//     --bundle --platform=node --format=cjs --packages=external --outfile=.wf-resume-e2e.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .wf-resume-e2e.cjs   # mimo 直连，别带代理
//   rm .wf-resume-e2e.cjs
// ============================================================================

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在任何 getDatabase()/import 触达 DB 单例前 chdir：DatabaseService 构造器读 cwd 定库路径。
const TMP_DIR = mkdtempSync(join(tmpdir(), 'wf-resume-e2e-'));
process.chdir(TMP_DIR);

import type { ModelConfig } from '../../src/shared/contract';
import type { ToolContext } from '../../src/main/protocol/tools';
import { workflowModule } from '../../src/main/tools/modules/multiagent/workflow';
import { initDatabase, getDatabase } from '../../src/main/services/core/databaseService';
import { getWorkflowJournalRepository } from '../../src/main/services/core/repositories/WorkflowJournalRepository';

function loadEnv(): Record<string, string> {
  const envPath = join(homedir(), '.code-agent', '.env');
  const out: Record<string, string> = {};
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
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
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string, meta?: unknown) => console.warn('[warn]', m, meta ?? ''),
    error: (m: string, meta?: unknown) => console.error('[error]', m, meta ?? ''),
  };
  return {
    sessionId: 'e2e-resume-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger,
    currentToolCallId: 'e2e-resume-tooluse',
    emit: () => {},
    modelConfig,
  } as ToolContext;
}

// 极小确定性脚本：2 个 forced agent（省 token）。call2 的 prompt 派生自 call1 结果 →
// 重放时 call1 命中返相同值 → call2 prompt 逐字一致 → 也命中。全确定性，适合验缓存。
const SCRIPT = `
phase('facts');
const a = await agent('List exactly 2 short key facts about: ' + args,
  { label: 'list-facts', schema: { type: 'object', properties: {
      facts: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } }, required: ['facts'] } });
phase('summarize');
const b = await agent('Summarize these facts in one sentence: ' + JSON.stringify(a.facts),
  { label: 'summarize', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } });
return { facts: a.facts, summary: b.summary };
`;

type Meta = { runId?: string; agentCallCount?: number; tokensSpent?: number; phases?: string[] };

async function runOnce(args: Record<string, unknown>, label: string) {
  const handler = await workflowModule.createHandler();
  const env = loadEnv();
  const modelConfig: ModelConfig = {
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    apiKey: env.XIAOMI_API_KEY,
    baseUrl: env.XIAOMI_API_URL || 'https://token-plan-sgp.xiaomimimo.com/v1',
    temperature: 0.3,
    maxTokens: 1024,
    reasoningEffort: 'low',
  };
  const ctx = buildMockCtx(modelConfig);
  const t0 = Date.now();
  const res = await handler.execute(args, ctx, (async () => ({ allow: true })) as never, () => {});
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== ${label} (${dt}s) === ok:`, res.ok, 'meta:', JSON.stringify(res.meta));
  if (!res.ok) console.error('  error:', res.error, res.code);
  return res;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.XIAOMI_API_KEY) throw new Error('XIAOMI_API_KEY not found in ~/.code-agent/.env');
  process.env.XIAOMI_API_KEY = env.XIAOMI_API_KEY;
  process.env.XIAOMI_API_URL = env.XIAOMI_API_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;

  await initDatabase();
  if (!getDatabase().isReady) throw new Error('DB 未就绪 — 无法验 journal 持久化');
  console.log('temp DB ready at', TMP_DIR);

  const goal = 'the Rust ownership model';

  // ── run1：真 mimo，写 journal ──
  const r1 = await runOnce({ script: SCRIPT, goal }, 'run1 (live, real mimo)');
  if (!r1.ok) throw new Error('run1 failed');
  const m1 = r1.meta as Meta;
  const runId1 = m1.runId!;

  // journal 落库核实
  const repo = getWorkflowJournalRepository();
  if (!repo) throw new Error('journal repo null — DB 未就绪');
  const journal1 = repo.loadRun(runId1);
  const callsRecorded = journal1?.calls.size ?? 0;

  // ── run2：同脚本 + resumeFromRunId → 应全缓存命中 ──
  const r2 = await runOnce({ script: SCRIPT, goal, resumeFromRunId: runId1 }, 'run2 (resume, all-cached)');
  if (!r2.ok) throw new Error('run2 failed');
  const m2 = r2.meta as Meta;

  // ── 断言 ──
  const checks = {
    run1_ok: r1.ok === true,
    run2_ok: r2.ok === true,
    run1_recorded_all_calls: callsRecorded === m1.agentCallCount && callsRecorded === 2,
    run1_spent_tokens: (m1.tokensSpent ?? 0) > 0,           // run1 真花了 token
    run2_zero_tokens: (m2.tokensSpent ?? -1) === 0,         // run2 全命中 → 0 token（核心证据）
    run2_same_callcount: m2.agentCallCount === m1.agentCallCount, // 同样跑了 2 个 call（只是命中）
    result_identical: r1.output === r2.output,              // 结果逐字一致
    run2_journal_selfcontained: (repo.loadRun(m2.runId!)?.calls.size ?? 0) === 2, // run2 journal 自包含
  };
  console.log('\n=== ASSERTIONS ===');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✅' : '❌'} ${k}`);
  console.log('\nrun1 tokensSpent:', m1.tokensSpent, '| run2 tokensSpent:', m2.tokensSpent);
  console.log('run1 output:', r1.output);
  console.log('run2 output:', r2.output);

  const pass = Object.values(checks).every(Boolean);
  console.log('\n=== RESUME E2E', pass ? 'PASS ✅' : 'FAIL ❌', '===');

  try { getDatabase().getDb()?.close(); } catch { /* ignore */ }
  rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('RESUME E2E crashed:', err);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
