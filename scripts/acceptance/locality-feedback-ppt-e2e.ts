#!/usr/bin/env npx tsx
// ============================================================================
// 定点反馈 loop Phase 2（PPT）编排派验 — 真模型
//
// 验证 Phase 2 核心论点：PPT 选区不走 envelope 结构化字段，而是 overlay 把锚点
// （pptx 路径 + 0-based slide_index）编进消息文本，真模型自路由到 ppt_edit 定向改对页。
// 这复刻 overlay 点击 PPT 某页后会产出的「锚点消息」，零 UI / 零 P0-2 触碰，先 derisk
// 「文本锚点 → 模型 → ppt_edit(file_path, slide_index)」这条路由是不是真的成立。
//
// 跑法（CJS bundle 让 keytar/jszip require 可用 + 删代理域内直连）：
//   npx esbuild scripts/acceptance/locality-feedback-ppt-e2e.ts --bundle --platform=node \
//     --format=cjs --packages=external --outfile=.lfb-ppt.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .lfb-ppt.cjs
// ============================================================================

import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  } catch { /* optional */ }
}

function prepareIsolatedHome(): { fakeHome: string; dataDir: string } {
  const fakeHome = mkdtempSync(join(tmpdir(), 'lfb-ppt-home-'));
  const dataDir = join(fakeHome, '.code-agent');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.CODE_AGENT_HOME = fakeHome;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  return { fakeHome, dataDir };
}

// 解 pptx（zip）读某页 XML 文本，验标题真改了。slide_index 0 → ppt/slides/slide1.xml
async function readSlideXml(pptxPath: string, slideIndex: number): Promise<string> {
  const mod = await import('jszip');
  const JSZip = mod.default ?? mod;
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  const entry = zip.file(`ppt/slides/slide${slideIndex + 1}.xml`);
  return entry ? entry.async('string') : '';
}

async function main(): Promise<void> {
  const realHome = process.env.HOME || homedir();
  loadEnvIntoProcess(realHome);
  const isolated = prepareIsolatedHome();
  console.log(`=== isolated HOME: ${isolated.fakeHome} ===`);
  delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
  delete process.env.https_proxy; delete process.env.http_proxy;

  console.log('=== initializeCLIServices ===');
  const { initializeCLIServices } = await import('../../src/cli/bootstrap');
  const { resolveSessionDefaultModelConfig } = await import('../../src/host/services/core/sessionDefaults');
  const { StandaloneAgentAdapter } = await import('../../src/host/testing/agentAdapter');
  await initializeCLIServices();
  const mc = resolveSessionDefaultModelConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  console.log('  xiaomi(mimo) apiKey:', mc.apiKey ? 'present ✓' : 'MISSING ✗');
  if (!mc.apiKey) throw new Error('xiaomi(mimo) apiKey 未配置');

  // 1. 拷一份 fixture deck 到临时目录（ppt_edit 会就地改）
  const dir = mkdtempSync(join(tmpdir(), 'lfb-ppt-e2e-'));
  const pptx = join(dir, 'deck.pptx');
  copyFileSync(join(process.cwd(), 'scripts/acceptance/fixtures/deck/sample-deck.pptx'), pptx);
  const TARGET_SLIDE = 0; // 0-based：第 1 页
  const NEW_TITLE = '定点反馈验证标题';
  const beforeXml = await readSlideXml(pptx, TARGET_SLIDE);
  console.log(`\n=== fixture: ${pptx} | 目标 slide_index=${TARGET_SLIDE} ===`);

  // 2. 复刻 overlay 点中 PPT 某页后产出的「锚点消息」（精确带 pptx 路径 + 0-based slide_index）
  const prompt =
    `[定点反馈] 用户在 PPT 预览里点选了《deck.pptx》的第 1 页（文件路径：${pptx}，slide_index=${TARGET_SLIDE}）。\n` +
    `针对这一页的诉求：把这页的标题改成「${NEW_TITLE}」。\n` +
    `请用 ppt_edit 工具，file_path 用上面给的路径，slide_index 用 ${TARGET_SLIDE}，做定向修改——只改这一页，不要动别的页。`;

  // 3. 真 mimo 跑一轮
  const agent = new StandaloneAgentAdapter({
    workingDirectory: dir,
    modelConfig: { ...mc, provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: mc.apiKey, temperature: 0.2, reasoningEffort: 'low', maxTokens: 2048 },
    toolMode: 'all',
    maxIterations: 10,
  });
  const t0 = Date.now();
  console.log('\n=== 真 mimo 跑一轮（toolMode=all，含 ppt_edit）===');
  const result = await agent.sendMessage(prompt);
  await agent.finalizeSession();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // 4. 断言
  const tools = result.toolExecutions.map((t) => t.tool);
  const pptCalls = result.toolExecutions.filter((t) => t.tool === 'ppt_edit');
  const editCall = pptCalls.find((t) => {
    const a = t.input as Record<string, unknown>;
    return String(a.file_path ?? '') === pptx && Number(a.slide_index ?? -1) === TARGET_SLIDE
      && String(a.action ?? '').includes('title');
  });
  const afterXml = await readSlideXml(pptx, TARGET_SLIDE);
  const titleChanged = afterXml.includes(NEW_TITLE) && afterXml !== beforeXml;

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('  工具序列:', tools.join(' → ') || '(无)');
  console.log('  ppt_edit 调用次数:', pptCalls.length);
  pptCalls.forEach((c, i) => {
    const a = c.input as Record<string, unknown>;
    console.log(`  ppt_edit[${i}]: action=${a.action} file_path=${a.file_path} slide_index=${a.slide_index} success=${c.success}`);
  });
  console.log('  errors:', result.errors.length ? result.errors.join(' | ') : '(无)');

  const pass = pptCalls.length > 0 && !!editCall && titleChanged;
  console.log('\n=== PPT 编排派验 ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  [1] 模型调用了 ppt_edit:', pptCalls.length > 0);
  console.log(`  [2] 命中正确 file_path + slide_index=${TARGET_SLIDE} + title 类 action:`, !!editCall);
  console.log(`  [3] 第 ${TARGET_SLIDE} 页标题真改成「${NEW_TITLE}」:`, titleChanged);
  rmSync(isolated.fakeHome, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error('E2E crashed:', err); process.exit(1); });
