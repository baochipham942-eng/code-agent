import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { counts, digest, inspectEvidence, parseCases, validateReport, type Case, type Row } from '../../scripts/nightly/contracts';

const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function inventory() {
  const text = Array.from({ length: 55 }, (_, i) => `### TC-M${i + 1}-01 · example\n\n| 夜跑标记 | 是 |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M${i + 1}-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`).join('\n');
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
  const files = ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'host.log', ...row.frames.flatMap(f => [`screens/${f}.png`, `screens/${f}.dom.json`])];
  for (const f of files) { writeFileSync(path.join(dir, f), f === 'result.json' ? JSON.stringify({ caseHash: spec.hash, checks: row.checks }) : f.endsWith('.dom.json') ? JSON.stringify({ criteria: [{ visible: true }] }) : 'fixture'); row.files[f] = digest(readFileSync(path.join(dir, f))); }
  return dir;
}
describe('nightly acceptance fail-closed evidence', () => {
  it('rejects incomplete inventories', () => expect(() => parseCases('### TC-M1-01 · partial\n')).toThrow('FAIL'));
  it('keeps all 55 unexecuted rows and zero runtime claims', () => { const cases = inventory(); const rows = rowsFor(cases); expect(counts(rows)).toEqual({ executed: 0, skipped: 55, failed: 0, passed: 0, total: 55 }); expect(validateReport(cases, rows, counts(rows), () => '')).toEqual([]); });
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
