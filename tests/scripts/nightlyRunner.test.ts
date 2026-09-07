import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { scopedHostLog, pipelineExitCode, counts, digest, inspectEvidence, parseCases, validateReport, type Case, type Row } from '../../scripts/nightly/contracts';

const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function inventory(count = 55) {
  const text = Array.from({ length: count }, (_, i) => `### TC-M${i + 1}-01 · example\n\n| 夜跑标记 | 是 |\n| 模块 | 上下文 |\n| 验收面 | api+web |\n| 步骤 | 浏览器打开详情；API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M${i + 1}-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`).join('\n');
  const cases = parseCases(text);
  cases[0].reasons = []; // Synthetic unblocked adapter for adversarial report tests.
  return cases;
}
function rowsFor(cases: Case[]): Row[] {
  return cases.map(c => ({ id: c.id, runId: 'run', status: '未执行', reasons: c.reasons.length ? c.reasons : ['runtime unavailable'], checks: [1, 2, 3].map(() => ({ status: '未执行', detail: 'not run' })), files: {}, frames: [] }));
}
function evidence(spec: Case, row: Row) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nightly-check-')); temporary.push(dir);
  mkdirSync(path.join(dir, 'screens'));
  row.status = '通过'; row.reasons = []; row.startedAt = '2026-09-06T00:00:00Z'; row.endedAt = '2026-09-06T00:00:01Z';
  row.checks = [1, 2, 3].map(() => ({ status: '通过', detail: 'observed' })); row.frames = ['01', '02', '03'];
  const files = ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'stdout.json', 'host.log', ...row.frames.flatMap(f => [`screens/${f}.png`, `screens/${f}.dom.json`])];
  for (const f of files) { writeFileSync(path.join(dir, f), f === 'result.json' ? JSON.stringify({ caseHash: spec.hash, checks: row.checks }) : f.endsWith('.dom.json') ? JSON.stringify({ criteria: [{ visible: true }] }) : 'fixture'); row.files[f] = digest(readFileSync(path.join(dir, f))); }
  writeFileSync(path.join(dir, 'files.sha256'), Object.entries(row.files).map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n');
  return dir;
}
describe('nightly acceptance fail-closed evidence', () => {
  it('keeps scheduled defect reporting alive while manual acceptance stays red', () => {
    const completed = { executed: 1, failed: 1, mechanismFailed: false, notificationDelivered: true, scheduled: true };
    expect(Array.from({ length: 6 }, () => pipelineExitCode(completed))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(pipelineExitCode({ ...completed, scheduled: false })).toBe(1);
    expect(pipelineExitCode({ ...completed, mechanismFailed: true })).toBe(1);
    expect(pipelineExitCode({ ...completed, executed: 0 })).toBe(1);
    expect(pipelineExitCode({ ...completed, notificationDelivered: false })).toBe(1);
  });
  it('withholds logs without a session and excludes unrelated errors', () => {
    const log = 'session-a observed\nERROR unrelated-sensitive-sentinel\nsession-b observed';
    expect(scopedHostLog(log, '')).not.toContain('sentinel');
    expect(scopedHostLog(log, '')).not.toContain('observed');
    expect(scopedHostLog(log, 'session-a')).toBe('session-a observed');
  });
  it('reports malformed assertion arrays without throwing', () => {
    const cases = inventory(); const rows = rowsFor(cases); rows[0].status = '失败'; rows[0].checks = [];
    expect(validateReport(cases, rows, counts(rows), () => '')).toContain('FAIL TC-M1-01 invalid tri-state assertions');
  });
  it('requires CLI output and a consistent hash manifest', () => {
    const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]);
    unlinkSync(path.join(dir, 'stdout.json')); writeFileSync(path.join(dir, 'files.sha256'), 'tampered');
    expect(inspectEvidence(rows[0], dir)).toContain('FAIL TC-M1-01 missing evidence stdout.json');
    expect(inspectEvidence(rows[0], dir)).toContain('FAIL TC-M1-01 files.sha256 missing or inconsistent');
  });
  it('rejects incomplete inventories', () => expect(() => parseCases('### TC-M1-01 · partial\n')).toThrow('FAIL'));
  it('parses 模块/验收面 for a known-good case (判定式真阳)', () => {
    const cases = inventory(1);
    expect(cases[0].modules).toEqual(['上下文']);
    expect(cases[0].surfaces).toEqual(['api', 'web']);
  });
  it('rejects 模块 outside the §7 subsystem domain (判定式真阴)', () => {
    expect(() => parseCases(`### TC-M1-01 · t\n\n| 夜跑标记 | 是 |\n| 模块 | 权限 |\n| 验收面 | api |\n| 步骤 | API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M1-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`)).toThrow('模块取值域外');
  });
  it('rejects 验收面 that disagrees with the 步骤 route (app without native shell)', () => {
    expect(() => parseCases(`### TC-M1-01 · t\n\n| 夜跑标记 | 是 |\n| 模块 | 上下文 |\n| 验收面 | api+app |\n| 步骤 | API 读取 health:get，浏览器打开详情 |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M1-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`)).toThrow('验收面与步骤不一致');
  });
  it('rejects missing 模块/验收面 rows instead of skipping silently', () => {
    expect(() => parseCases(`### TC-M1-01 · t\n\n| 夜跑标记 | 是 |\n| 验收面 | api |\n| 步骤 | API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M1-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`)).toThrow('missing 模块');
    expect(() => parseCases(`### TC-M1-01 · t\n\n| 夜跑标记 | 是 |\n| 模块 | 上下文 |\n| 步骤 | API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M1-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`)).toThrow('missing 验收面');
  });
  it('distinguishes zero matched headings from a genuinely empty doc (判定式边界)', () => {
    expect(() => parseCases('# 没有用例标题的文档\n\nCASES-2026-09-06\n')).toThrow('case inventory empty');
  });
  it('floats the case count instead of pinning 55', () => {
    const cases = inventory(3);
    expect(cases).toHaveLength(3);
    const rows = rowsFor(cases);
    expect(validateReport(cases, rows, counts(rows), () => '')).toEqual([]);
    expect(validateReport(cases, [...rows, rows[0]], counts([...rows, rows[0]]), () => '')[0]).toContain('must show all 3 cases exactly once');
  });
  it('cross-checks the 场景×状态覆盖矩阵 against the parsed inventory', () => {
    const one = `### TC-M1-01 · a\n\n| 夜跑标记 | 是 |\n| 模块 | 上下文 |\n| 验收面 | api |\n| 步骤 | API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M1-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`;
    const two = one.replace(/M1-01/g, 'M1-02');
    const matrix = (count: string) => `## 场景 × 状态覆盖矩阵\n\n| 场景 | 用例 | 状态/异常轴 |\n|---|---|---|\n| M1 | ${count} | 覆盖 |\n\n## 逐条用例\n\n`;
    expect(() => parseCases(matrix('TC-M1-01、TC-M1-02') + one + two)).not.toThrow();
    expect(() => parseCases(matrix('TC-M1-01') + one + two)).toThrow('覆盖矩阵与逐条用例不一致');
    // 矩阵标题在但一条用例行都没选中 = 选择器漂移，不能当成"无矩阵"跳过
    expect(() => parseCases(`## 场景 × 状态覆盖矩阵\n\n| 场景 | 用例 | 状态/异常轴 |\n|---|---|---|\n| 坏行 | 坏 | 坏 |\n\n## 逐条用例\n\n` + one)).toThrow('没有选中任何用例行');
  });
  it('keeps all 55 unexecuted rows and zero runtime claims', () => { const cases = inventory(); const rows = rowsFor(cases); expect(counts(rows)).toEqual({ executed: 0, skipped: cases.length, failed: 0, passed: 0, total: cases.length }); expect(validateReport(cases, rows, counts(rows), () => '')).toEqual([]); });
  it('mutation 1 rejects blocked promotion independently of forged summary', () => { const cases = inventory(); const rows = rowsFor(cases); const top = counts(rows); rows[1].status = '通过'; expect(validateReport(cases, rows, top, () => '')).toContain('FAIL COUNTS top summary differs from case table'); expect(validateReport(cases, rows, counts(rows), () => '').some(e => e.includes('blocked case'))).toBe(true); });
  it('rejects hidden or duplicated skipped cases', () => { const cases = inventory(); const rows = rowsFor(cases); rows[54] = rows[0]; expect(validateReport(cases, rows, counts(rows), () => '').some(e => e.includes('INVENTORY'))).toBe(true); });
  it('rejects green assertion cells on unexecuted rows', () => { const cases = inventory(); const rows = rowsFor(cases); rows[0].checks[2].status = '通过'; expect(validateReport(cases, rows, counts(rows), () => '')).toContain('FAIL TC-M1-01 skipped row must not be green'); });
  it('mutation 2 rejects missing intermediate screenshot', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); unlinkSync(path.join(dir, 'screens/02.png')); expect(inspectEvidence(rows[0], dir)).toContain('FAIL TC-M1-01 missing evidence screens/02.png'); expect(validateReport(cases, rows, counts(rows), () => dir).length).toBeGreaterThan(0); });
  it('rejects empty DOM criteria even with recomputed evidence hashes', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); const file = 'screens/03.dom.json'; writeFileSync(path.join(dir, file), '{"criteria":[]}'); rows[0].files[file] = digest(readFileSync(path.join(dir, file))); expect(validateReport(cases, rows, counts(rows), () => dir)).toContain('FAIL TC-M1-01 unsatisfied DOM criteria screens/03.dom.json'); });
  it('rejects changed DOM even if screenshots are intact', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); writeFileSync(path.join(dir, 'screens/02.dom.json'), '{"visible":false}'); expect(inspectEvidence(rows[0], dir)).toContain('FAIL TC-M1-01 evidence hash mismatch screens/02.dom.json'); });
  it('rejects forged pass when original result has a failed assertion', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); const file = path.join(dir, 'result.json'); writeFileSync(file, JSON.stringify({ caseHash: cases[0].hash, checks: [{ status: '失败' }] })); rows[0].files['result.json'] = digest(readFileSync(file)); expect(validateReport(cases, rows, counts(rows), () => dir)).toContain('FAIL TC-M1-01 result provenance/assertions disagree'); });
  it('rejects a result from an older case specification', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); cases[0].hash = 'new spec'; expect(validateReport(cases, rows, counts(rows), () => dir)).toContain('FAIL TC-M1-01 result provenance/assertions disagree'); });
  it('distinguishes a real failed run from a skipped run', () => { const cases = inventory(); const rows = rowsFor(cases); const dir = evidence(cases[0], rows[0]); rows[0].status = '失败'; rows[0].checks[0].status = '失败'; expect(counts(rows)).toEqual({ executed: 1, skipped: 54, failed: 1, passed: 0, total: 55 }); expect(validateReport(cases, rows, counts(rows), () => dir)).toEqual([]); });
});
