// ============================================================================
// dynamic-workflow E2E (full-agent 路径) —— agent() 无 schema = 完整 execute loop
//
// 补齐 deep-research E2E 未覆盖的分支：agent() 不带 schema 时走 SubagentExecutor.execute
// 完整 agent loop（真工具 dispatch），而非 forced 单轮。用 initializeCLIServices()（真
// webServer/CLI 同源 bootstrap）起真 configService + 工具注册表 + ToolResolver，让 workflow
// 工具的 deriveSubagentContext 拿到真 resolver。任务用 glob（只读、无网络、确定性）。
//
// 跑法（输出到 worktree 内，--packages=external 要 node 向上解析 symlink 的 node_modules）：
//   node_modules/.bin/esbuild scripts/acceptance/script-runtime-fullagent-e2e.ts \
//     --bundle --platform=node --format=cjs --packages=external --outfile=.wf-fa-e2e.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .wf-fa-e2e.cjs   # mimo 直连
// ============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../src/host/protocol/tools';
import { workflowModule } from '../../src/host/tools/modules/multiagent/workflow';
import { initializeCLIServices } from '../../src/cli/bootstrap';
import { getToolResolver } from '../../src/host/tools/dispatch/toolResolver';
import { resolveSessionDefaultModelConfig } from '../../src/host/services/core/sessionDefaults';

function loadEnvIntoProcess(): void {
  const envPath = join(homedir(), '.code-agent', '.env');
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

// 无 schema 的 full-agent：让子 agent 用 glob 工具（defaultAgentTools 含 glob）数文件。
// 期望 7 个 .ts：agentBridge / concurrencyGate / index / primitives / runService / sandbox / types。
const ORCHESTRATION_SCRIPT = `
phase('scan');
log('full-agent path: counting scriptRuntime .ts files via glob');
const answer = await agent(
  'Use the glob tool with pattern "src/host/agent/scriptRuntime/*.ts" to list the TypeScript files there, ' +
  'then reply with exactly how many there are and their base filenames. Be concise.'
);
return { answer };
`;

async function main(): Promise<void> {
  loadEnvIntoProcess();
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;

  console.log('=== initializeCLIServices (real configService + tool registry + resolver) ===');
  await initializeCLIServices();

  const modelConfig = {
    ...resolveSessionDefaultModelConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro' }),
    reasoningEffort: 'low' as const,
    maxTokens: 1536,
  };
  if (!modelConfig.apiKey) throw new Error('no apiKey resolved for xiaomi — check ~/.code-agent/.env / configService');

  const resolver = getToolResolver();
  console.log('  resolver has workflow tool:', resolver.has('workflow'), '| has Glob:', resolver.has('Glob'));

  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string, meta?: unknown) => console.warn('[warn]', m, meta ?? ''),
    error: (m: string, meta?: unknown) => console.error('[error]', m, meta ?? ''),
  };
  const ctx = {
    sessionId: 'fa-e2e-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger,
    currentToolCallId: 'fa-e2e-tooluse-1',
    emit: () => {},
    modelConfig,
    resolver,
  } as unknown as ToolContext;

  const handler = await workflowModule.createHandler();
  const canUseTool = async () => ({ allow: true });

  const t0 = Date.now();
  console.log('=== running workflow (no-schema full-agent) with real mimo ===');
  const result = await handler.execute(
    { script: ORCHESTRATION_SCRIPT, goal: 'count scriptRuntime ts files' },
    ctx,
    canUseTool as never,
    (p) => console.log('  [progress]', p.stage, p.detail ?? ''),
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('ok:', result.ok);
  if (!result.ok) {
    console.error('error:', result.error, 'code:', result.code, 'meta:', JSON.stringify(result.meta));
    process.exit(1);
  }
  console.log('meta:', JSON.stringify(result.meta));
  console.log('output:\n' + result.output);
  const parsed = JSON.parse(result.output);
  const answer = String(parsed.answer ?? '');
  // 断言：full-agent 真跑（agentCallCount=1）+ 返回非空文本 + 提到正确文件数 7（glob 真执行的证据）
  const mentions7 = /\b7\b|七/.test(answer);
  const pass =
    (result.meta as { agentCallCount?: number })?.agentCallCount === 1 &&
    answer.length > 10 &&
    mentions7;
  console.log('\n=== ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  agentCallCount=1:', (result.meta as { agentCallCount?: number })?.agentCallCount === 1);
  console.log('  answer non-empty:', answer.length > 10);
  console.log('  mentions count 7 (glob really ran):', mentions7);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
