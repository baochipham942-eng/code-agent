#!/usr/bin/env npx tsx
// ============================================================================
// 定点反馈 loop Phase 3（表格）编排派验 — 真模型
//
// 验证表格定点反馈：overlay 点选某单元格后，用真实 buildLocalityFeedbackMessage 把锚点
// （xlsx 路径 + cell "B2"）编进消息，真 mimo 自路由到 DocEdit 改对单元格。
// 直接 dogfood 生产构造器（非另写 prompt），零 UI / 零 P0-2 触碰。
//
// 跑法：
//   npx esbuild scripts/acceptance/locality-feedback-sheet-e2e.ts --bundle --platform=node \
//     --format=cjs --packages=external --outfile=.lfb-sheet.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .lfb-sheet.cjs
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
  const fakeHome = mkdtempSync(join(tmpdir(), 'lfb-sheet-home-'));
  const dataDir = join(fakeHome, '.code-agent');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.CODE_AGENT_HOME = fakeHome;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  return { fakeHome, dataDir };
}

async function readCell(xlsx: string, cell: string): Promise<unknown> {
  const mod = await import('exceljs') as typeof import('exceljs') & { default?: typeof import('exceljs') };
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.worksheets[0];
  const v = ws.getCell(cell).value;
  return v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : v;
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
  const { buildLocalityFeedbackMessage } = await import('../../src/shared/livePreview/localityFeedback');
  await initializeCLIServices();
  const mc = resolveSessionDefaultModelConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  console.log('  xiaomi(mimo) apiKey:', mc.apiKey ? 'present ✓' : 'MISSING ✗');
  if (!mc.apiKey) throw new Error('xiaomi(mimo) apiKey 未配置');

  // 1. 拷 xlsx fixture 到临时目录
  const dir = mkdtempSync(join(tmpdir(), 'lfb-sheet-e2e-'));
  const xlsx = join(dir, 'data.xlsx');
  copyFileSync(join(process.cwd(), 'benchmarks/excel-benchmark/selected_10/382-29/1_382-29_input.xlsx'), xlsx);
  const TARGET_CELL = 'B2';
  const NEW_VALUE = 99999;
  const before = await readCell(xlsx, TARGET_CELL);
  console.log(`\n=== fixture: ${xlsx} | 目标单元格 ${TARGET_CELL}（原值=${JSON.stringify(before)}）===`);

  // 2. dogfood 生产构造器：模拟 overlay 点选 B2 产出的锚点消息
  const prompt = buildLocalityFeedbackMessage(
    { kind: 'sheet', filePath: xlsx, cell: TARGET_CELL, displayName: 'data.xlsx' },
    `把这个单元格的值改成 ${NEW_VALUE}`,
  );
  console.log('--- 锚点消息(生产构造器产出) ---\n' + prompt);

  // 3. 真 mimo 跑一轮
  const agent = new StandaloneAgentAdapter({
    workingDirectory: dir,
    modelConfig: { ...mc, provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: mc.apiKey, temperature: 0.2, reasoningEffort: 'low', maxTokens: 2048 },
    toolMode: 'all',
    maxIterations: 10,
  });
  const t0 = Date.now();
  console.log('\n=== 真 mimo 跑一轮（toolMode=all，含 DocEdit）===');
  const result = await agent.sendMessage(prompt);
  await agent.finalizeSession();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  // 4. 断言
  const tools = result.toolExecutions.map((t) => t.tool);
  const docCalls = result.toolExecutions.filter((t) => t.tool === 'DocEdit');
  const hitTarget = docCalls.some((t) => {
    const a = t.input as Record<string, unknown>;
    const blob = JSON.stringify(a);
    return blob.includes(xlsx) && blob.includes(TARGET_CELL);
  });
  const after = await readCell(xlsx, TARGET_CELL);
  const cellChanged = String(after) === String(NEW_VALUE);

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('  工具序列:', tools.join(' → ') || '(无)');
  console.log('  DocEdit 调用次数:', docCalls.length);
  docCalls.forEach((c, i) => console.log(`  DocEdit[${i}]: input=${JSON.stringify(c.input).slice(0, 240)} success=${c.success}`));
  console.log(`  ${TARGET_CELL} 改后值:`, JSON.stringify(after));
  console.log('  errors:', result.errors.length ? result.errors.join(' | ') : '(无)');

  const pass = docCalls.length > 0 && hitTarget && cellChanged;
  console.log('\n=== 表格编排派验 ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  [1] 模型调用了 DocEdit:', docCalls.length > 0);
  console.log(`  [2] 命中 xlsx 路径 + 单元格 ${TARGET_CELL}:`, hitTarget);
  console.log(`  [3] ${TARGET_CELL} 真改成 ${NEW_VALUE}:`, cellChanged);
  rmSync(isolated.fakeHome, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error('E2E crashed:', err); process.exit(1); });
