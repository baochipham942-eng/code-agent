/**
 * SpreadsheetBlock 端到端自动化测试
 *
 * 测试链路: 创建 Excel → extract-excel-json API → 验证 JSON 结构 → 验证 SpreadsheetSpec 格式
 *
 * 运行: npx tsx scripts/test-spreadsheet.ts
 * 前提: Web 服务器运行中 (npm run dev 或 cargo tauri dev)
 */

import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BASE_URL = process.env.CA_URL || 'http://localhost:8180';
const LOG_FILE = path.join(os.homedir(), '.code-agent', 'logs', 'test-spreadsheet.log');

// Read auth token from .dev-token (written by web server on startup)
function getAuthToken(): string {
  const tokenPath = path.join(process.cwd(), '.dev-token');
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    throw new Error(`Cannot read auth token from ${tokenPath}. Is the server running?`);
  }
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getAuthToken()}`,
  };
}

// ── Logging ────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* non-blocking */ }
}

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    log(`  ✅ ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, duration, error });
    log(`  ❌ ${name} (${duration}ms): ${error}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ── Test Data ──────────────────────────────────────────────────────────────

function createTestExcel(filePath: string) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 销售数据
  const salesData = [
    ['地区', '产品', '销售额', '利润', '日期'],
    ['华东', 'A产品', 12000, 3600, '2026-01'],
    ['华北', 'B产品', 8500, 2100, '2026-01'],
    ['华南', 'A产品', 15000, 4500, '2026-02'],
    ['西南', 'C产品', 6200, 1800, '2026-02'],
    ['华东', 'B产品', 9800, 2940, '2026-03'],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, ws1, '销售数据');

  // Sheet 2: 库存
  const inventoryData = [
    ['SKU', '名称', '库存', '单价'],
    ['A001', 'A产品', 500, 120],
    ['B002', 'B产品', 320, 85],
    ['C003', 'C产品', 180, 62],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(inventoryData);
  XLSX.utils.book_append_sheet(wb, ws2, '库存');

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testServerHealth() {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert(res.status === 200, `Health check failed: ${res.status}`);
}

async function testExtractExcelJson(filePath: string) {
  const res = await fetch(`${BASE_URL}/api/extract/excel-json`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filePath }),
  });
  assert(res.ok, `API returned ${res.status}`);

  const data = await res.json();

  // Structure validation
  assert(Array.isArray(data.sheets), 'sheets should be array');
  assert(data.sheetCount === 2, `Expected 2 sheets, got ${data.sheetCount}`);

  // Sheet 1
  const s1 = data.sheets[0];
  assert(s1.name === '销售数据', `Sheet1 name: ${s1.name}`);
  assert(Array.isArray(s1.headers), 'headers should be array');
  assert(s1.headers.length === 5, `Expected 5 headers, got ${s1.headers.length}`);
  assert(s1.headers[0] === '地区', `First header: ${s1.headers[0]}`);
  assert(s1.headers[2] === '销售额', `Third header: ${s1.headers[2]}`);
  assert(s1.rows.length === 5, `Expected 5 data rows, got ${s1.rows.length}`);
  assert(s1.rowCount === 5, `rowCount: ${s1.rowCount}`);

  // Data type check
  assert(typeof s1.rows[0][2] === 'number', `销售额 should be number, got ${typeof s1.rows[0][2]}`);
  assert(s1.rows[0][2] === 12000, `First 销售额: ${s1.rows[0][2]}`);

  // Sheet 2
  const s2 = data.sheets[1];
  assert(s2.name === '库存', `Sheet2 name: ${s2.name}`);
  assert(s2.headers.length === 4, `Expected 4 headers, got ${s2.headers.length}`);
  assert(s2.rows.length === 3, `Expected 3 rows, got ${s2.rows.length}`);

  return data;
}

async function testExtractExcelText(filePath: string) {
  const res = await fetch(`${BASE_URL}/api/extract/excel`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filePath }),
  });
  assert(res.ok, `API returned ${res.status}`);

  const data = await res.json();
  assert(typeof data.text === 'string', 'text should be string');
  assert(data.text.includes('销售额'), 'text should contain header');
  assert(data.sheetCount === 2, `sheetCount: ${data.sheetCount}`);
  assert(data.rowCount > 0, `rowCount: ${data.rowCount}`);
}

async function testSpreadsheetSpecFormat(jsonData: unknown) {
  // Validate that the JSON can be used as SpreadsheetBlock spec
  const spec = jsonData as { sheets: Array<{ name: string; headers: string[]; rows: unknown[][]; rowCount: number }>; sheetCount: number };
  const specStr = JSON.stringify(spec);

  // Parse back (simulates what SpreadsheetBlock does)
  const parsed = JSON.parse(specStr);
  assert(Array.isArray(parsed.sheets), 'parsed.sheets should be array');
  assert(parsed.sheets[0].headers.length > 0, 'headers should not be empty');
  assert(parsed.sheets[0].rows.length > 0, 'rows should not be empty');

  // Size check (should be reasonable for embedding in messages)
  const sizeKB = specStr.length / 1024;
  assert(sizeKB < 500, `Spec too large: ${sizeKB.toFixed(1)}KB (max 500KB)`);
  log(`    Spec size: ${sizeKB.toFixed(1)}KB`);
}

async function testColumnTypeInference(jsonData: unknown) {
  const spec = jsonData as { sheets: Array<{ rows: unknown[][] }> };
  const rows = spec.sheets[0].rows;

  // Column 0 (地区) should be text
  const col0Types = rows.map(r => typeof r[0]);
  assert(col0Types.every(t => t === 'string'), '地区 column should be all strings');

  // Column 2 (销售额) should be numbers
  const col2Types = rows.map(r => typeof r[2]);
  assert(col2Types.every(t => t === 'number'), '销售额 column should be all numbers');
}

async function testPathTraversal() {
  const res = await fetch(`${BASE_URL}/api/extract/excel-json`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filePath: '../../../etc/passwd' }),
  });
  // Server blocks '..' with 403 or resolves it to non-existent → 404, both acceptable
  assert(res.status === 403 || res.status === 404, `Path traversal should be blocked (403/404), got ${res.status}`);
}

async function testMissingFile() {
  const res = await fetch(`${BASE_URL}/api/extract/excel-json`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filePath: '/tmp/nonexistent-file-12345.xlsx' }),
  });
  assert(res.status === 404, `Missing file should return 404, got ${res.status}`);
}

async function testInvalidPayload() {
  const res = await fetch(`${BASE_URL}/api/extract/excel-json`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  assert(res.status === 400 || res.status === 404, `Empty payload should return 400/404, got ${res.status}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  log('═'.repeat(60));
  log('SpreadsheetBlock 自动化测试');
  log('═'.repeat(60));
  log(`Server: ${BASE_URL}`);
  log(`Time: ${new Date().toLocaleString('zh-CN')}`);
  log('');

  // Create test file
  const tmpDir = path.join(os.tmpdir(), 'ca-test');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, 'test-spreadsheet.xlsx');
  createTestExcel(testFile);
  log(`Test file: ${testFile}`);
  log('');

  // Run tests
  log('── API Tests ──');
  await runTest('Server health check', testServerHealth);
  await runTest('Path traversal blocked', testPathTraversal);
  await runTest('Missing file returns 404', testMissingFile);
  await runTest('Invalid payload returns 400', testInvalidPayload);

  log('');
  log('── Excel Extract Tests ──');
  await runTest('extract-excel-text API', () => testExtractExcelText(testFile));

  let jsonData: unknown = null;
  await runTest('extract-excel-json API', async () => {
    jsonData = await testExtractExcelJson(testFile);
  });

  if (jsonData) {
    log('');
    log('── SpreadsheetBlock Tests ──');
    await runTest('Spec format validation', () => testSpreadsheetSpecFormat(jsonData));
    await runTest('Column type inference', () => testColumnTypeInference(jsonData));
  }

  // Cleanup
  try { fs.unlinkSync(testFile); } catch { /* ok */ }

  // Summary
  log('');
  log('═'.repeat(60));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const totalTime = results.reduce((a, r) => a + r.duration, 0);

  if (failed === 0) {
    log(`✅ ALL PASSED: ${passed}/${total} tests (${totalTime}ms)`);
  } else {
    log(`❌ FAILED: ${failed}/${total} tests failed`);
    for (const r of results.filter(r => !r.passed)) {
      log(`   - ${r.name}: ${r.error}`);
    }
  }
  log('═'.repeat(60));

  // Write JSON summary for cron analysis
  const summaryPath = path.join(os.homedir(), '.code-agent', 'logs', 'test-spreadsheet-latest.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    server: BASE_URL,
    passed, failed, total, totalTime,
    results,
  }, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log(`Fatal: ${err}`);
  process.exit(2);
});
