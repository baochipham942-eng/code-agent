import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export type Case = { id: string; title: string; fields: Record<string, string>; hash: string; root: string; reasons: string[] };
export type Check = { status: '通过' | '失败' | '未执行'; detail: string };
export type Row = { id: string; runId: string; status: Check['status']; reasons: string[]; checks: Check[]; files: Record<string, string>; frames: string[]; fb?: string; startedAt?: string; endedAt?: string };
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function parseCases(source: string): Case[] {
  const blocks = [...source.matchAll(/^### (TC-M\d+-\d+) · (.+)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)];
  const cases = blocks.map((m) => {
    const fields = Object.fromEntries([...m[3].matchAll(/^\| ([^|]+) \| (.+) \|$/gm)].map(x => [x[1].trim(), x[2].trim()]));
    for (const key of ['夜跑标记', '证据落点', '①结果断言', '②过程断言', '③渲染断言']) if (!fields[key]) throw new Error(`FAIL ${m[1]} missing ${key}`);
    const root = fields['证据落点'].match(/`([^`]+)\/runs\/TC-M\d+-\d+\/<run-id>\/result.json`/)?.[1];
    if (!root) throw new Error(`FAIL ${m[1]} evidence path not frozen`);
    const reasons: string[] = [];
    if (m[1] === 'TC-M1-01' && digest(m[0]) !== '37f4701f22a10859c37cdfb452f15ead6efcf47894cc93479ff5608d185cbc39') reasons.push('runner 尚未支持这类证据：用例规格已变化，须重新审核适配器');
    const scenario = Number(m[1].match(/M(\d+)/)![1]);
    const gaps: Record<number, string> = { 3: '预警/将满', 5: '容量未知', 11: '取消终态', 19: '经济学拒绝', 20: '五种失败 reason', 23: '预算/额度拒绝' };
    if (gaps[scenario]) reasons.push(`缺稿（align 第3次对齐：${gaps[scenario]}）`);
    if (m[1] === 'TC-M2-02') reasons.push('缺稿（align 第3次对齐：估算徽章/偏差）；目标态未达成（FB-117）');
    if ([5, 24, 27, 28].includes(scenario) || /取消/.test(m[3])) reasons.push('协议字段未冻结（cases 异议 D11）');
    const fb = m[3].match(/FB-(109|112|117)/g);
    if (fb) reasons.push(`目标态未达成（${[...new Set(fb)].join('/')}）`);
    if (fields['夜跑标记'] !== '是') reasons.push('夜跑标记=否（仅手工）');
    if (m[1] !== 'TC-M1-01') reasons.push('runner 尚未支持这类证据：本条全部参数组的运行时适配器');
    return { id: m[1], title: m[2], fields, hash: digest(m[0]), root, reasons };
  });
  if (cases.length !== 55 || new Set(cases.map(c => c.id)).size !== 55) throw new Error(`FAIL case inventory expected 55, got ${cases.length}`);
  return cases;
}
export function counts(rows: Row[]) {
  return { executed: rows.filter(r => r.status !== '未执行').length, skipped: rows.filter(r => r.status === '未执行').length, failed: rows.filter(r => r.status === '失败').length, passed: rows.filter(r => r.status === '通过').length, total: rows.length };
}
export function inspectEvidence(row: Row, dir: string): string[] {
  const errors: string[] = [];
  for (const file of ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'host.log', ...row.frames.flatMap(f => [`screens/${f}.png`, `screens/${f}.dom.json`])]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) errors.push(`FAIL ${row.id} missing evidence ${file}`);
    else if (row.files[file] !== digest(readFileSync(full))) errors.push(`FAIL ${row.id} evidence hash mismatch ${file}`);
  }
  if (row.frames.length < 3) errors.push(`FAIL ${row.id} render requires initial/pending/snapshot frames`);
  return errors;
}
export function validateReport(cases: Case[], rows: Row[], summary: ReturnType<typeof counts>, dirFor: (row: Row) => string): string[] {
  const errors: string[] = [];
  if (JSON.stringify(counts(rows)) !== JSON.stringify(summary)) errors.push('FAIL COUNTS top summary differs from case table');
  if (rows.length !== 55 || new Set(rows.map(r => r.id)).size !== 55 || cases.some(c => !rows.some(r => r.id === c.id))) errors.push('FAIL INVENTORY must show all 55 cases exactly once');
  for (const row of rows) {
    const spec = cases.find(c => c.id === row.id);
    if (!spec) { errors.push(`FAIL unknown case ${row.id}`); continue; }
    if (!['通过', '失败', '未执行'].includes(row.status) || row.checks.length !== 3) errors.push(`FAIL ${row.id} invalid tri-state assertions`);
    if (spec.reasons.length && row.status !== '未执行') errors.push(`FAIL ${row.id} blocked case promoted to ${row.status}`);
    if (row.status === '未执行') {
      if (!row.reasons.length || row.checks.some(c => c.status !== '未执行')) errors.push(`FAIL ${row.id} skipped row must not be green`);
    } else {
      if (!row.startedAt || !row.endedAt) errors.push(`FAIL ${row.id} missing execution timestamps`);
      const evidenceErrors = inspectEvidence(row, dirFor(row));
      if (row.status === '通过') {
        errors.push(...evidenceErrors);
        if (row.checks.some(c => c.status !== '通过')) errors.push(`FAIL ${row.id} pass requires all three assertions`);
        const resultPath = path.join(dirFor(row), 'result.json');
        if (existsSync(resultPath)) {
          const result = JSON.parse(readFileSync(resultPath, 'utf8'));
          if (result.caseHash !== spec.hash || !Array.isArray(result.checks) || result.checks.length !== 3 || result.checks.some((c: Check) => c.status !== '通过')) errors.push(`FAIL ${row.id} result provenance/assertions disagree`);
        }
      }
      if (row.status === '失败' && row.checks.every(c => c.status === '通过')) errors.push(`FAIL ${row.id} failed row has no failed assertion`);
      if (evidenceErrors.length && row.checks[2].status === '通过') errors.push(...evidenceErrors);
    }
  }
  return errors;
}
