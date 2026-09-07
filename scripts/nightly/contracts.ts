import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export type Case = { id: string; title: string; modules: string[]; surfaces: string[]; severity: string; frequency: string; priority: string; fields: Record<string, string>; hash: string; root: string; reasons: string[] };
/** 【模块】取值域 = docs/ARCHITECTURE.md §7 子系统职责表的子系统名（含表尾补充职责行），逐字照抄；改 §7 须同步这里。 */
export const SUBSYSTEM_NAMES = ['会话执行', '会话任务', 'Durable run', '多代理', '脚本编排', '工具', '模型', '外部引擎', '上下文', '记忆与角色', '数据', '平台壳', '前端与 IPC', '浏览器与电脑', '插件与连接器', '设计与产物', '语音与活动', '定时与自动化', '评测与观测', '补充职责'];
/** 【验收面】取值域；声明值必须与该条【步骤】实际写的路线一致，SURFACE_MARKERS 负责从步骤文本机械推导。 */
export const SURFACES = ['cli', 'api', 'web', 'app'];
/** 【影响程度】取值域 = 致命/严重/一般/轻微（判据见 cases.md 任务书：数据丢失·会话不可用·安全越界·付费重复 > 主流程受阻有绕行·误导·信号悬空 > 体验受损·信息不准 > 文案观感）。 */
export const SEVERITY_LEVELS = ['致命', '严重', '一般', '轻微'];
/** 【触发频率】取值域 = 每轮/常见/偶发/罕见（判据见 cases.md 任务书：每轮=每轮对话都走到，如健康快照读取/事件发出；常见=正常使用多数会话遇到，如手动压缩/预警态/压缩成功；偶发=特定配置或时序才触发，如冷却期内/窗口解析失败/并发双入口/摘要校验不过；罕见=仅开发者路径或极端边界，如 CLI 调试/诊断查询/无库降级/L4 缺摘要器）。 */
export const FREQUENCIES = ['每轮', '常见', '偶发', '罕见'];
/** 【优先级】取值域 = P0/P1/P2，与 PRD §6 功能点清单、requirements-pool.md 同口径，不新造档位。 */
export const PRIORITIES = ['P0', 'P1', 'P2'];
/** 优先级矩阵 = 单一真源（行=影响程度，列=触发频率）。优先级不再自由填写：parseCases 按此重算并与填写值比对，不符即红；改矩阵只改这里。 */
export const PRIORITY_MATRIX: Record<string, Record<string, string>> = {
  '致命': { '每轮': 'P0', '常见': 'P0', '偶发': 'P0', '罕见': 'P1' },
  '严重': { '每轮': 'P0', '常见': 'P1', '偶发': 'P1', '罕见': 'P2' },
  '一般': { '每轮': 'P1', '常见': 'P2', '偶发': 'P2', '罕见': 'P2' },
  '轻微': { '每轮': 'P2', '常见': 'P2', '偶发': 'P2', '罕见': 'P2' },
};
export function derivePriority(severity: string, frequency: string): string {
  return PRIORITY_MATRIX[severity]?.[frequency] ?? '';
}
const SURFACE_MARKERS: Record<string, RegExp> = {
  cli: /CLI|neo debug/,
  api: /API|invoke|health:get|响应体|compact-current|compact-from/,
  web: /浏览器/,
  app: /Tauri|原生壳|系统权限/,
};
export type Check = { status: '通过' | '失败' | '未执行'; detail: string };
export type Row = { id: string; runId: string; status: Check['status']; reasons: string[]; checks: Check[]; files: Record<string, string>; frames: string[]; fb?: string; fbCreated?: boolean; startedAt?: string; endedAt?: string };
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function parseCases(source: string): Case[] {
  const blocks = [...source.matchAll(/^### (TC-M\d+-\d+) · (.+)\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)];
  if (!blocks.length) throw new Error('FAIL case inventory empty: 没有 "### TC-M… · …" 标题被选中（cases.md 缺失或格式漂移，与"真的零条"区分）');
  const cases = blocks.map((m) => {
    const fields = Object.fromEntries([...m[3].matchAll(/^\| ([^|]+) \| (.+) \|$/gm)].map(x => [x[1].trim(), x[2].trim()]));
    for (const key of ['夜跑标记', '证据落点', '模块', '验收面', '影响程度', '触发频率', '优先级', '①结果断言', '②过程断言', '③渲染断言']) if (!fields[key]) throw new Error(`FAIL ${m[1]} missing ${key}`);
    const modules = fields['模块'].split('·').map(name => name.trim()).filter(Boolean);
    if (!modules.length || modules.some(name => !SUBSYSTEM_NAMES.includes(name))) throw new Error(`FAIL ${m[1]} 模块取值域外：${fields['模块']}（取值域=ARCHITECTURE.md §7 子系统名，可多值用 · 分隔）`);
    const surfaces = fields['验收面'].split('+').map(face => face.trim()).filter(Boolean);
    if (!surfaces.length || surfaces.some(face => !SURFACES.includes(face)) || new Set(surfaces).size !== surfaces.length) throw new Error(`FAIL ${m[1]} 验收面取值域外：${fields['验收面']}（取值域=cli/api/web/app，可组合用 + 连接）`);
    const derived = SURFACES.filter(face => SURFACE_MARKERS[face].test(fields['步骤'] ?? ''));
    if (derived.length !== surfaces.length || surfaces.some(face => !derived.includes(face))) throw new Error(`FAIL ${m[1]} 验收面与步骤不一致：字段=${fields['验收面']}，步骤实际路线=${derived.join('+') || '无'}`);
    if (!SEVERITY_LEVELS.includes(fields['影响程度'])) throw new Error(`FAIL ${m[1]} 影响程度取值域外：${fields['影响程度']}（取值域=致命/严重/一般/轻微）`);
    if (!FREQUENCIES.includes(fields['触发频率'])) throw new Error(`FAIL ${m[1]} 触发频率取值域外：${fields['触发频率']}（取值域=每轮/常见/偶发/罕见）`);
    if (!PRIORITIES.includes(fields['优先级'])) throw new Error(`FAIL ${m[1]} 优先级取值域外：${fields['优先级']}（取值域=P0/P1/P2）`);
    const expectedPriority = derivePriority(fields['影响程度'], fields['触发频率']);
    if (fields['优先级'] !== expectedPriority) throw new Error(`FAIL ${m[1]} 优先级与矩阵不符：影响程度=${fields['影响程度']} 触发频率=${fields['触发频率']} 期望=${expectedPriority} 实际=${fields['优先级']}`);
    const root = fields['证据落点'].match(/`([^`]+)\/runs\/TC-M\d+-\d+\/<run-id>\/result.json`/)?.[1];
    if (!root) throw new Error(`FAIL ${m[1]} evidence path not frozen`);
    const reasons: string[] = [];
    if (m[1] === 'TC-M1-01' && digest(m[0]) !== 'f0de84bc843fc3d2a68372c549c77d208164a98cf45b0ae24e363c76e00bbf21') reasons.push('runner 尚未支持这类证据：用例规格已变化，须重新审核适配器');
    const scenario = Number(m[1].match(/M(\d+)/)![1]);
    const gaps: Record<number, string> = { 3: '预警/将满', 5: '容量未知', 11: '取消终态', 19: '经济学拒绝', 20: '五种失败 reason', 23: '预算/额度拒绝' };
    if (gaps[scenario]) reasons.push(`缺稿（align 第3次对齐：${gaps[scenario]}）`);
    if (m[1] === 'TC-M2-02') reasons.push('缺稿（align 第3次对齐：估算徽章/偏差）；目标态未达成（FB-117）');
    if ([5, 24, 27, 28].includes(scenario) || /取消/.test(m[3])) reasons.push('协议字段未冻结（cases 异议 D11）');
    const fb = m[3].match(/FB-(109|112|117)/g);
    if (fb) reasons.push(`目标态未达成（${[...new Set(fb)].join('/')}）`);
    if (fields['夜跑标记'] !== '是') reasons.push('夜跑标记=否（仅手工）');
    if (m[1] !== 'TC-M1-01') reasons.push('runner 尚未支持这类证据：本条全部参数组的运行时适配器');
    return { id: m[1], title: m[2], modules, surfaces, severity: fields['影响程度'], frequency: fields['触发频率'], priority: fields['优先级'], fields, hash: digest(m[0]), root, reasons };
  });
  const ids = cases.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error(`FAIL case ids not unique: 解析 ${ids.length} 条出现重复`);
  // 总数不写死：用 cases.md 自己的「场景 × 状态覆盖矩阵」作对照清单，增删用例必须连矩阵一起改，否则红。
  // 矩阵是必需件：缺矩阵时任一非空用例子集都能静默通过（旧的总数写死至少挡得住"少几条"），
  // 必须抛错，且「没有矩阵」与「有矩阵但没选中任何用例行」两种情形分开报。
  if (!/^## 场景 × 状态覆盖矩阵$/m.test(source)) throw new Error('FAIL 覆盖矩阵缺失：没有 "## 场景 × 状态覆盖矩阵" 章节，完整性校验失去对照清单（与"有矩阵但没选中任何用例行"区分）');
  const matrixIds = [...source.matchAll(/^\| M\d+ \| ((?:TC-M\d+-\d+、)*TC-M\d+-\d+) \|/gm)].flatMap(m => m[1].split('、'));
  if (!matrixIds.length) throw new Error('FAIL 覆盖矩阵标题存在但没有选中任何用例行（选择器漂移，先修解析再谈计数）');
  const onlyMatrix = matrixIds.filter(id => !ids.includes(id));
  const onlyCases = ids.filter(id => !matrixIds.includes(id));
  if (onlyMatrix.length || onlyCases.length) throw new Error(`FAIL 覆盖矩阵与逐条用例不一致：矩阵 ${matrixIds.length} 条、实际解析 ${ids.length} 条；仅在矩阵=${onlyMatrix.join('、') || '无'}；仅在实际=${onlyCases.join('、') || '无'}`);
  return cases;
}
export function counts(rows: Row[]) {
  return { executed: rows.filter(r => r.status !== '未执行').length, skipped: rows.filter(r => r.status === '未执行').length, failed: rows.filter(r => r.status === '失败').length, passed: rows.filter(r => r.status === '通过').length, total: rows.length };
}
export function inspectEvidence(row: Row, dir: string): string[] {
  const errors: string[] = [];
  for (const file of ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'stdout.json', 'host.log', ...row.frames.flatMap(f => [`screens/${f}.png`, `screens/${f}.dom.json`])]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) errors.push(`FAIL ${row.id} missing evidence ${file}`);
    else if (row.files[file] !== digest(readFileSync(full))) errors.push(`FAIL ${row.id} evidence hash mismatch ${file}`);
  }
  const hashes = path.join(dir, 'files.sha256');
  const expectedHashes = Object.entries(row.files).map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n';
  if (!existsSync(hashes) || readFileSync(hashes, 'utf8') !== expectedHashes) errors.push(`FAIL ${row.id} files.sha256 missing or inconsistent`);
  for (const frame of row.frames) {
    const file = path.join(dir, `screens/${frame}.dom.json`);
    if (!existsSync(file)) continue;
    try {
      const dom = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(dom.criteria) || dom.criteria.length === 0 || dom.criteria.some((c: { visible?: boolean }) => c.visible !== true)) errors.push(`FAIL ${row.id} unsatisfied DOM criteria screens/${frame}.dom.json`);
    } catch { errors.push(`FAIL ${row.id} invalid DOM evidence screens/${frame}.dom.json`); }
  }
  if (row.frames.length < 3) errors.push(`FAIL ${row.id} render requires initial/pending/snapshot frames`);
  return errors;
}
export function validateReport(cases: Case[], rows: Row[], summary: ReturnType<typeof counts>, dirFor: (row: Row) => string): string[] {
  const errors: string[] = [];
  if (JSON.stringify(counts(rows)) !== JSON.stringify(summary)) errors.push('FAIL COUNTS top summary differs from case table');
  if (rows.length !== cases.length || new Set(rows.map(r => r.id)).size !== cases.length || cases.some(c => !rows.some(r => r.id === c.id))) errors.push(`FAIL INVENTORY must show all ${cases.length} cases exactly once`);
  for (const row of rows) {
    const spec = cases.find(c => c.id === row.id);
    if (!spec) { errors.push(`FAIL unknown case ${row.id}`); continue; }
    if (!['通过', '失败', '未执行'].includes(row.status) || row.checks.length !== 3) { errors.push(`FAIL ${row.id} invalid tri-state assertions`); continue; }
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
      if (row.status !== '通过' && evidenceErrors.length && row.checks[2].status === '通过') errors.push(...evidenceErrors);
    }
  }
  return errors;
}

/** Product failures are report data; infrastructure failures must still fail the scheduler. */
export function pipelineExitCode(input: { executed: number; failed: number; mechanismFailed: boolean; notificationDelivered: boolean; scheduled: boolean }): number {
  if (input.mechanismFailed || input.executed === 0 || !input.notificationDelivered) return 1;
  return input.failed > 0 && !input.scheduled ? 1 : 0;
}

/** No session scope means no host logs, including unrelated ERROR lines. */
export function scopedHostLog(log: string, sessionId: string): string {
  if (!sessionId.trim()) return '未采集：前置环境不可用，没有可限定的会话 ID。\n';
  return log.split('\n').filter(line => line.includes(sessionId)).join('\n');
}

/** Same frozen assertion group and failure shape share a defect; numeric observations vary per run. */
export function feedbackFingerprint(row: Row, caseHash: string, mutation: boolean): string {
  return digest(JSON.stringify({ id: row.id, caseHash, mutation, checks: row.checks.map(c => ({ status: c.status, detail: c.detail.replace(/\d+(?:\.\d+)?/g, '#') })) }));
}
