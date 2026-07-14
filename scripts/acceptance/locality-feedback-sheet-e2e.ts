#!/usr/bin/env npx tsx
// ============================================================================
// 定点反馈 loop Phase 3（表格）编排派验 — 真模型
//
// 验证的是「模型听不听话」：拿到带坐标的锚点消息后，是否真的自路由到 DocEdit
// 并照着给定的工作表 + 单元格改，而不是自作主张换个位置。
//
// ⚠️ 坐标本身对不对不归这里管，也不该归这里管——那是免费的确定性测试的活：
//   tests/unit/shared/sheetLocalityRoundtrip.test.ts        提取 → A1 → DocEdit 写入
//   tests/renderer/components/spreadsheetBlock.localityAnchor.test.tsx  点选 → 锚点坐标
//
// 历史教训（2026-07-14）：这个脚本的前一版自述「零 UI」，手工构造 filePath 和 "B2"
// 直接喂给模型，从不经过 UI 的 A1 计算。于是预览侧的行错位（空行被压缩）和工作表错位
// （sheet.name 没传）两个洞在它眼皮底下活了很久——脚本永远绿，用户的表格被静默改错。
// 现在坐标一律从真提取 handler + UI 同一个换算函数得出，fixture 也带上了空行和第二张表。
//
// 跑法（付费真模型，默认只跑一次）：
//   npx esbuild scripts/acceptance/locality-feedback-sheet-e2e.ts --bundle --platform=node \
//     --format=cjs --packages=external --outfile=.lfb-sheet.cjs
//   env -u HTTPS_PROXY -u HTTP_PROXY node .lfb-sheet.cjs
// ============================================================================

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

interface SheetPreview { name: string; headers: string[]; rows: unknown[][]; rowCount: number }

/**
 * fixture：两张表，每张都在中间夹一个空行。
 * 「三月」在 xlsx 里是第 4 行 —— 空行一旦被压缩就会算成第 3 行；
 * 目标在第 2 张表 —— 表名一旦没传，写侧会静默落到第 1 张表。
 * 两个坑都埋在这一个 fixture 里。
 */
async function writeFixture(dir: string): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const monthly = (march: number) => [['月份', '销售额'], ['一月', march / 3], [], ['三月', march]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthly(300)), 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthly(3000)), 'Summary');
  const filePath = join(dir, 'sales.xlsx');
  writeFileSync(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

/** 走真实的 extract-excel-json handler，拿到预览侧看到的数据 */
async function extractPreview(filePath: string): Promise<SheetPreview[]> {
  const { registerSettingsHandlers } = await import('../../src/host/ipc/settings.ipc');
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  const handler = handlers.get('extract-excel-json');
  if (!handler) throw new Error('extract-excel-json 未注册');
  const { sheets } = (await handler(null, filePath)) as { sheets: SheetPreview[] };
  return sheets;
}

async function readCell(xlsx: string, sheetName: string, cell: string): Promise<unknown> {
  const mod = await import('exceljs') as typeof import('exceljs') & { default?: typeof import('exceljs') };
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`工作表 ${sheetName} 不存在`);
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
  const { sheetCellRef } = await import('../../src/shared/livePreview/sheetCoords');
  await initializeCLIServices();
  const mc = resolveSessionDefaultModelConfig({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  console.log('  xiaomi(mimo) apiKey:', mc.apiKey ? 'present ✓' : 'MISSING ✗');
  if (!mc.apiKey) throw new Error('xiaomi(mimo) apiKey 未配置');

  // 1. 造 fixture（空行 + 双表）
  const dir = mkdtempSync(join(tmpdir(), 'lfb-sheet-e2e-'));
  const xlsx = await writeFixture(dir);

  // 2. 走真提取 handler，模拟用户在预览里切到第 2 张表、点「三月」的销售额格
  const sheets = await extractPreview(xlsx);
  const targetSheet = sheets[1];
  const SALES_COLUMN = 1;
  const marchIndex = targetSheet.rows.findIndex((r) => (r as unknown[])?.[0] === '三月');
  if (marchIndex < 0) throw new Error('预览里没找到「三月」这一行——提取链路已经坏了');
  // 坐标由 UI 同一个换算函数得出，不手工构造
  const TARGET_CELL = sheetCellRef(marchIndex, SALES_COLUMN);
  const TARGET_SHEET = targetSheet.name;
  const NEW_VALUE = 99999;

  const before = await readCell(xlsx, TARGET_SHEET, TARGET_CELL);
  const guardBefore = await readCell(xlsx, 'Sheet1', TARGET_CELL);
  console.log(`\n=== fixture: ${xlsx} ===`);
  console.log(`  预览侧算出的目标：工作表「${TARGET_SHEET}」单元格 ${TARGET_CELL}（原值=${JSON.stringify(before)}）`);
  console.log(`  非目标对照：Sheet1!${TARGET_CELL}（原值=${JSON.stringify(guardBefore)}），必须纹丝不动`);

  // 3. dogfood 生产构造器：预览点选产出的锚点消息
  const prompt = buildLocalityFeedbackMessage(
    { kind: 'sheet', filePath: xlsx, cell: TARGET_CELL, sheetName: TARGET_SHEET, displayName: 'sales.xlsx' },
    `把这个单元格的值改成 ${NEW_VALUE}`,
  );
  console.log('--- 锚点消息(生产构造器产出) ---\n' + prompt);

  // 4. 真 mimo 跑一轮
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

  // 5. 断言
  const tools = result.toolExecutions.map((t) => t.tool);
  const docCalls = result.toolExecutions.filter((t) => t.tool === 'DocEdit');
  const hitTarget = docCalls.some((t) => {
    const blob = JSON.stringify(t.input as Record<string, unknown>);
    return blob.includes(xlsx) && blob.includes(TARGET_CELL) && blob.includes(TARGET_SHEET);
  });
  const after = await readCell(xlsx, TARGET_SHEET, TARGET_CELL);
  const guardAfter = await readCell(xlsx, 'Sheet1', TARGET_CELL);
  const cellChanged = String(after) === String(NEW_VALUE);
  const otherSheetIntact = String(guardAfter) === String(guardBefore);

  console.log(`\n=== outcome (${dt}s) ===`);
  console.log('  工具序列:', tools.join(' → ') || '(无)');
  console.log('  DocEdit 调用次数:', docCalls.length);
  docCalls.forEach((c, i) => console.log(`  DocEdit[${i}]: input=${JSON.stringify(c.input).slice(0, 240)} success=${c.success}`));
  console.log(`  ${TARGET_SHEET}!${TARGET_CELL} 改后值:`, JSON.stringify(after));
  console.log(`  Sheet1!${TARGET_CELL} 改后值:`, JSON.stringify(guardAfter));
  console.log('  errors:', result.errors.length ? result.errors.join(' | ') : '(无)');

  const pass = docCalls.length > 0 && hitTarget && cellChanged && otherSheetIntact;
  console.log('\n=== 表格编排派验 ASSERT', pass ? 'PASS ✅' : 'FAIL ❌', '===');
  console.log('  [1] 模型调用了 DocEdit:', docCalls.length > 0);
  console.log(`  [2] 命中 xlsx 路径 + 工作表 ${TARGET_SHEET} + 单元格 ${TARGET_CELL}:`, hitTarget);
  console.log(`  [3] ${TARGET_SHEET}!${TARGET_CELL} 真改成 ${NEW_VALUE}:`, cellChanged);
  console.log(`  [4] 非目标 Sheet1!${TARGET_CELL} 纹丝不动:`, otherSheetIntact);
  rmSync(isolated.fakeHome, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error('E2E crashed:', err); process.exit(1); });
