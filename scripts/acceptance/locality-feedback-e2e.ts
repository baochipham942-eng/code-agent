#!/usr/bin/env npx tsx
// ============================================================================
// 定点反馈 loop E2E（真模型）
//
// 验证全链路：envelope.context.livePreviewSelection
//   → buildWorkbenchTurnSystemContext 注入 <live_preview_selection>（Layer A，本次新增）
//   → 复刻 orchestrator.applyTurnSystemContext 拼进 prompt
//   → 真 mimo 路由到 visual_edit（按注入的 file/line）
//   → visual_edit 经 zhipu 产 diff 原子落盘
//   → 断言：visual_edit 命中正确 file:line + 源文件文字改对
//
// 这覆盖本期真缺口（main 侧消费选区）+ 模型真路由 + 真改文件。渲染器点击→选区入
// envelope 的上半段由 composerStore.test.ts 覆盖，此处不重复。
//
// 跑法（mimo + zhipu 均域内直连，删代理；node 向上解析主仓库 node_modules）：
//   env -u HTTPS_PROXY -u HTTP_PROXY npx tsx scripts/acceptance/locality-feedback-e2e.ts
// ============================================================================

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

function loadEnvIntoProcess(realHome = homedir()): void {
  try {
    const envPath = join(realHome, '.code-agent', '.env');
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
  } catch {
    /* env 可选 */
  }
}

function prepareIsolatedHome(): { fakeHome: string; dataDir: string } {
  const fakeHome = mkdtempSync(join(tmpdir(), 'locality-fb-home-'));
  const dataDir = join(fakeHome, '.code-agent');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.CODE_AGENT_HOME = fakeHome;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  return { fakeHome, dataDir };
}

// 复刻 src/host/agent/agentOrchestrator.ts:943 applyTurnSystemContext 的拼装格式，
// 保证 E2E 喂给模型的 prompt 与生产主循环逐字一致。
function applyTurnSystemContext(content: string, turnSystemContext: string[]): string {
  const lines = turnSystemContext.filter((i) => i.trim().length > 0);
  if (lines.length === 0) return content;
  return `${lines.join('\n\n')}\n\n<user_request>\n${content}\n</user_request>`;
}

async function main(): Promise<void> {
  const realHome = process.env.HOME || homedir();
  loadEnvIntoProcess(realHome);
  const isolated = prepareIsolatedHome();
  console.log(`=== isolated HOME: ${isolated.fakeHome} ===`);
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;

  console.log('=== initializeCLIServices ===');
  const { initializeCLIServices } = await import('../../src/cli/bootstrap');
  const { getConfigService } = await import('../../src/host/services/core/configService');
  const { resolveSessionDefaultModelConfig } = await import('../../src/host/services/core/sessionDefaults');
  const { buildWorkbenchTurnSystemContext } = await import('../../src/host/app/workbenchTurnContext');
  const { StandaloneAgentAdapter } = await import('../../src/host/testing/agentAdapter');
  await initializeCLIServices();

  // 前置：key 探针（缺则早退，不白烧 mimo）
  const cfg = getConfigService();
  const mc = resolveSessionDefaultModelConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  const zhipuKey = cfg?.getApiKey('zhipu');
  console.log('  xiaomi(mimo) apiKey:', mc.apiKey ? 'present ✓' : 'MISSING ✗');
  console.log('  zhipu apiKey (visual_edit 视觉模型用):', zhipuKey ? 'present ✓' : 'MISSING ✗');
  if (!mc.apiKey) throw new Error('xiaomi(mimo) apiKey 未配置 — 在设置里配 mimo Key 后重试');
  if (!zhipuKey) throw new Error('zhipu apiKey 未配置 — visual_edit 需要智谱视觉模型，在设置里配后重试');

  // 1. 临时项目 + 真实可改的 React 文件（button 在已知行）
  const dir = mkdtempSync(join(tmpdir(), 'locality-fb-e2e-'));
  const fileRel = 'src/App.tsx';
  const file = join(dir, fileRel);
  mkdirSync(join(dir, 'src'), { recursive: true });
  const sourceLines = [
    'export function App() {',
    '  return (',
    '    <div className="container">',
    '      <button className="cta">提交</button>',
    '    </div>',
    '  );',
    '}',
    '',
  ];
  writeFileSync(file, sourceLines.join('\n'), 'utf8');
  const btnLine = sourceLines.findIndex((l) => l.includes('<button')) + 1;
  console.log(`\n=== fixture: ${file} (button 在第 ${btnLine} 行) ===`);

  // 2. 真实 Layer A：把选区喂给本次新增的 buildWorkbenchTurnSystemContext
  const turnSystemContext = buildWorkbenchTurnSystemContext({
    livePreviewSelection: {
      location: { file, line: btnLine, column: 7 },
      tag: 'button',
      text: '提交',
      rect: { x: 0, y: 0, width: 80, height: 36 },
    },
  });
  const hasBlock = turnSystemContext.some((b) => b.includes('<live_preview_selection>'));
  console.log('  Layer A 注入 <live_preview_selection>:', hasBlock ? 'YES ✓' : 'NO ✗');
  if (!hasBlock) throw new Error('Layer A 未注入选区块 — 回归');

  // 3. 复刻 orchestrator prompt 拼装（选区 block + 用户诉求）
  const userIntent = '把这个按钮的文字改成「立即报名」';
  const prompt = applyTurnSystemContext(userIntent, turnSystemContext);

  // 4. 真 mimo 跑一轮
  const agent = new StandaloneAgentAdapter({
    workingDirectory: dir,
    modelConfig: {
      ...mc,
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      apiKey: mc.apiKey,
      temperature: 0.2,
      reasoningEffort: 'low',
      maxTokens: 2048,
    },
    toolMode: 'all',
    maxIterations: 8,
  });

  const t0 = Date.now();
  console.log('\n=== 真 mimo 跑一轮（toolMode=all） ===');
  const result = await agent.sendMessage(prompt);
  await agent.finalizeSession();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // 5. 断言
  const tools = result.toolExecutions.map((t) => t.tool);
  const visualEditCalls = result.toolExecutions.filter((t) => t.tool === 'visual_edit');
  const hitRightTarget = visualEditCalls.some((t) => {
    const f = String((t.input as Record<string, unknown>).file ?? '');
    const ln = Number((t.input as Record<string, unknown>).line ?? -1);
    return (f === file || f.endsWith(fileRel)) && ln === btnLine;
  });
  const after = readFileSync(file, 'utf8');
  const changed = after.includes('立即报名') && !/>\s*提交\s*</.test(after);

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('  调用的工具序列:', tools.join(' → ') || '(无)');
  console.log('  visual_edit 调用次数:', visualEditCalls.length);
  if (visualEditCalls.length) {
    const inp = visualEditCalls[0].input as Record<string, unknown>;
    console.log('  首次 visual_edit 入参: file=%s line=%s intent=%s', inp.file, inp.line, inp.userIntent);
    console.log('  visual_edit 成功:', visualEditCalls[0].success);
  }
  console.log('  errors:', result.errors.length ? result.errors.join(' | ') : '(无)');
  console.log('\n--- 改后文件 ---\n' + after);

  const pass = hasBlock && visualEditCalls.length > 0 && hitRightTarget && changed;
  console.log('\n=== ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  [1] Layer A 注入选区块:', hasBlock);
  console.log('  [2] 模型调用了 visual_edit:', visualEditCalls.length > 0);
  console.log(`  [3] visual_edit 命中正确 file:line (${fileRel}:${btnLine}):`, hitRightTarget);
  console.log('  [4] 源文件文字改对（"提交"→"立即报名"）:', changed);

  rmSync(dir, { recursive: true, force: true });
  rmSync(isolated.fakeHome, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
