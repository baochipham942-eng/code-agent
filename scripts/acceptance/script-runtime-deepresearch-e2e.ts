// ============================================================================
// dynamic-workflow E2E —— 真模型(mimo)跑通 workflow 工具 handler 全链路
//
// 直接驱动 *真正的* workflowModule handler（命令层接线）→ startRun → worker 沙箱 →
// 真 mimo forced structured output。覆盖 4 原语：phase / pipeline / agent({schema}) / parallel。
//
// 跑法（worktree 无 tsx，用 esbuild bundle 后 node）：
//   node_modules/.bin/esbuild scripts/acceptance/script-runtime-deepresearch-e2e.ts \
//     --bundle --platform=node --format=cjs --packages=external --outfile=/tmp/wf-e2e.cjs
//   node /tmp/wf-e2e.cjs
// 注意：mimo 直连，**不要**设 HTTPS_PROXY。
// ============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfig } from '../../src/shared/contract';
import type { ToolContext } from '../../src/main/protocol/tools';
import { workflowModule } from '../../src/main/tools/modules/multiagent/workflow';

// ── 1. 从 ~/.code-agent/.env 读 xiaomi 凭证（standalone 无 configService）────────
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// ── 2. mock protocol ToolContext ───────────────────────────────────────────
function buildMockCtx(modelConfig: ModelConfig): ToolContext {
  const logger = {
    debug: (m: string, meta?: unknown) => console.log('[debug]', m, meta ?? ''),
    info: (m: string, meta?: unknown) => console.log('[info]', m, meta ?? ''),
    warn: (m: string, meta?: unknown) => console.warn('[warn]', m, meta ?? ''),
    error: (m: string, meta?: unknown) => console.error('[error]', m, meta ?? ''),
  };
  return {
    sessionId: 'e2e-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger,
    currentToolCallId: 'e2e-tooluse-1',
    emit: () => {},
    modelConfig,
  } as ToolContext;
}

// ── 3. 模型当场会写的编排脚本（deep-research demo，覆盖 4 原语）─────────────────
const ORCHESTRATION_SCRIPT = `
phase('decompose');
log('breaking topic into sub-questions');
const plan = await agent(
  'Break this research topic into exactly 2 focused, distinct sub-questions. Topic: ' + args,
  { label: 'decompose', schema: { type: 'object', properties: {
      questions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
    required: ['questions'] } }
);

phase('investigate');
const findings = await pipeline(
  plan.questions,
  (q) => agent('Answer this sub-question concisely from your knowledge, with one concrete fact: ' + q,
    { label: 'investigate', schema: { type: 'object', properties: {
        finding: { type: 'string' }, confidence: { type: 'number' } },
      required: ['finding', 'confidence'] } })
);

phase('verify');
const verdicts = await parallel(
  findings.filter(Boolean).map((f) => () =>
    agent('Is this claim plausible and self-consistent? Claim: ' + f.finding,
      { label: 'verify', schema: { type: 'object', properties: {
          plausible: { type: 'boolean' } }, required: ['plausible'] } })
  )
);

phase('synthesize');
const report = await agent(
  'Write a 3-sentence cited synthesis answering "' + args + '" from these findings: ' + JSON.stringify(findings),
  { label: 'synthesize', schema: { type: 'object', properties: {
      report: { type: 'string' } }, required: ['report'] } }
);

return {
  questions: plan.questions,
  findingCount: findings.filter(Boolean).length,
  plausibleCount: verdicts.filter(Boolean).filter((v) => v.plausible).length,
  report: report.report,
};
`;

async function main(): Promise<void> {
  const env = loadEnv();
  const apiKey = env.XIAOMI_API_KEY;
  const baseUrl = env.XIAOMI_API_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
  if (!apiKey) throw new Error('XIAOMI_API_KEY not found in ~/.code-agent/.env');
  // 让 provider resolution 的 env 兜底也拿得到；mimo 直连，确保不带 HTTPS_PROXY。
  process.env.XIAOMI_API_KEY = apiKey;
  process.env.XIAOMI_API_URL = baseUrl;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;

  const modelConfig: ModelConfig = {
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    apiKey,
    baseUrl,
    temperature: 0.3,
    maxTokens: 2048,
    reasoningEffort: 'low', // 关掉重思考，forced 单轮够用且省 token
  };

  const ctx = buildMockCtx(modelConfig);
  const handler = await workflowModule.createHandler();
  const canUseTool = async () => ({ allow: true });

  const goal = 'What makes Rust memory-safe without a garbage collector?';
  const t0 = Date.now();
  console.log('=== running workflow tool with real mimo ===');
  const result = await handler.execute(
    { script: ORCHESTRATION_SCRIPT, goal },
    ctx,
    canUseTool as never,
    (p) => console.log('  [progress]', p.stage, p.detail ?? ''),
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('ok:', result.ok);
  if (result.ok) {
    console.log('meta:', JSON.stringify(result.meta));
    console.log('output:\n' + result.output);
    const parsed = JSON.parse(result.output);
    const pass =
      Array.isArray(parsed.questions) && parsed.questions.length === 2 &&
      parsed.findingCount === 2 &&
      typeof parsed.report === 'string' && parsed.report.length > 20 &&
      (result.meta as { agentCallCount?: number })?.agentCallCount === 6;
    console.log('\n=== ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
    console.log('  questions=2:', parsed.questions?.length === 2);
    console.log('  findingCount=2:', parsed.findingCount === 2);
    console.log('  plausibleCount:', parsed.plausibleCount);
    console.log('  report.len:', parsed.report?.length);
    console.log('  agentCallCount=6:', (result.meta as { agentCallCount?: number })?.agentCallCount === 6);
    console.log('  phases:', JSON.stringify((result.meta as { phases?: string[] })?.phases));
    process.exit(pass ? 0 : 1);
  } else {
    console.error('error:', result.error, 'code:', result.code, 'meta:', JSON.stringify(result.meta));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
