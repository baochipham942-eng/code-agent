import type {
  ApprovalBucket,
  ApprovalDecision,
  ApprovalEvalReport,
  ApprovalRow,
} from './approval-eval';

export type ApprovalDiffDimension = 'isKnownSafeCommand' | 'decision' | 'riskLevel' | 'reason';
export type ApprovalDiffDirection = 'relaxed' | 'tightened' | 'changed';

type ApprovalDiffValue = string | boolean | null;

export interface ApprovalDimensionDiff {
  dimension: ApprovalDiffDimension;
  baseline: ApprovalDiffValue;
  candidate: ApprovalDiffValue;
  direction: ApprovalDiffDirection;
  failClosed: boolean;
}

export interface ApprovalCaseDiff {
  bucket: ApprovalBucket;
  id: string;
  tool: string;
  input: string;
  changes: ApprovalDimensionDiff[];
  failClosed: boolean;
}

export interface ApprovalDiffResult {
  ok: boolean;
  tablesDir: string;
  comparedCases: number;
  changedCases: number;
  failClosedCases: number;
  cases: ApprovalCaseDiff[];
}

const DECISION_ORDER: Record<ApprovalDecision, number> = { deny: 0, ask: 1, allow: 2 };
const RISK_ORDER: Record<Exclude<ApprovalRow['riskLevel'], null>, number> = {
  safe: 0,
  unknown: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

function fail(message: string): never {
  throw new Error(`[approval-diff] ${message}`);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} 必须是字符串`);
  return value;
}

function parseRow(value: unknown, source: string, index: number): ApprovalRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${source}.rows[${index}] 必须是对象`);
  const row = value as Partial<ApprovalRow>;
  const bucket = requireString(row.bucket, `${source}.rows[${index}].bucket`);
  if (!['benign', 'dangerous', 'injection'].includes(bucket)) fail(`${source}.rows[${index}].bucket 非法`);
  const actual = requireString(row.actual, `${source}.rows[${index}].actual`);
  const expected = requireString(row.expected, `${source}.rows[${index}].expected`);
  if (!['allow', 'ask', 'deny'].includes(actual)) fail(`${source}.rows[${index}].actual 非法`);
  if (!['allow', 'ask', 'deny'].includes(expected)) fail(`${source}.rows[${index}].expected 非法`);
  if (typeof row.isKnownSafeCommand !== 'boolean' && row.isKnownSafeCommand !== null) {
    fail(`${source}.rows[${index}].isKnownSafeCommand 必须是 boolean|null`);
  }
  if (row.riskLevel !== null && !Object.hasOwn(RISK_ORDER, row.riskLevel as string)) {
    fail(`${source}.rows[${index}].riskLevel 非法`);
  }
  if (row.reason !== null && typeof row.reason !== 'string') fail(`${source}.rows[${index}].reason 必须是 string|null`);
  return {
    ...row,
    bucket: bucket as ApprovalBucket,
    id: requireString(row.id, `${source}.rows[${index}].id`),
    tool: requireString(row.tool, `${source}.rows[${index}].tool`),
    input: requireString(row.input, `${source}.rows[${index}].input`),
    expected: expected as ApprovalDecision,
    actual: actual as ApprovalDecision,
    detail: requireString(row.detail, `${source}.rows[${index}].detail`),
    isKnownSafeCommand: row.isKnownSafeCommand,
    riskLevel: row.riskLevel ?? null,
    reason: row.reason,
  };
}

export function parseApprovalEvalReport(value: unknown, source: string): ApprovalEvalReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${source} 必须是对象`);
  const report = value as Partial<ApprovalEvalReport>;
  if (report.schemaVersion !== 1) fail(`${source}.schemaVersion 必须是 1`);
  if (!Array.isArray(report.rows)) fail(`${source}.rows 必须是数组`);
  return {
    ...report,
    schemaVersion: 1,
    generatedAt: requireString(report.generatedAt, `${source}.generatedAt`),
    tablesDir: requireString(report.tablesDir, `${source}.tablesDir`),
    ratchet: report.ratchet as ApprovalEvalReport['ratchet'],
    gate: report.gate as ApprovalEvalReport['gate'],
    rows: report.rows.map((row, index) => parseRow(row, source, index)),
  };
}

function orderedDirection(baseline: number, candidate: number): ApprovalDiffDirection {
  return candidate > baseline ? 'relaxed' : 'tightened';
}

function compareRow(baseline: ApprovalRow, candidate: ApprovalRow): ApprovalCaseDiff | null {
  const changes: ApprovalDimensionDiff[] = [];

  if (baseline.isKnownSafeCommand !== candidate.isKnownSafeCommand) {
    const unsafeToSafe = baseline.isKnownSafeCommand === false && candidate.isKnownSafeCommand === true;
    changes.push({
      dimension: 'isKnownSafeCommand',
      baseline: baseline.isKnownSafeCommand,
      candidate: candidate.isKnownSafeCommand,
      direction: unsafeToSafe ? 'relaxed' : 'tightened',
      failClosed: unsafeToSafe,
    });
  }

  if (baseline.actual !== candidate.actual) {
    const direction = orderedDirection(DECISION_ORDER[baseline.actual], DECISION_ORDER[candidate.actual]);
    changes.push({
      dimension: 'decision',
      baseline: baseline.actual,
      candidate: candidate.actual,
      direction,
      failClosed: direction === 'relaxed',
    });
  }

  if (baseline.riskLevel !== candidate.riskLevel) {
    const direction = baseline.riskLevel === null || candidate.riskLevel === null
      ? 'changed'
      : RISK_ORDER[candidate.riskLevel] < RISK_ORDER[baseline.riskLevel]
        ? 'relaxed'
        : 'tightened';
    changes.push({
      dimension: 'riskLevel',
      baseline: baseline.riskLevel,
      candidate: candidate.riskLevel,
      direction,
      failClosed: false,
    });
  }

  if (baseline.reason !== candidate.reason) {
    changes.push({
      dimension: 'reason',
      baseline: baseline.reason,
      candidate: candidate.reason,
      direction: 'changed',
      failClosed: false,
    });
  }

  if (changes.length === 0) return null;
  return {
    bucket: baseline.bucket,
    id: baseline.id,
    tool: baseline.tool,
    input: baseline.input,
    changes,
    failClosed: changes.some((change) => change.failClosed),
  };
}

function assertSameCase(baseline: ApprovalRow, candidate: ApprovalRow): void {
  for (const field of ['bucket', 'tool', 'input', 'expected', 'expectedRule'] as const) {
    if (baseline[field] !== candidate[field]) {
      fail(`${baseline.id} 的 ${field} 两侧不一致：${String(baseline[field])} != ${String(candidate[field])}`);
    }
  }
}

export function diffApprovalReports(
  baseline: ApprovalEvalReport,
  candidate: ApprovalEvalReport,
): ApprovalDiffResult {
  if (baseline.tablesDir !== candidate.tablesDir) {
    fail(`两侧 tablesDir 不一致：${baseline.tablesDir} != ${candidate.tablesDir}`);
  }

  const baselineById = new Map<string, ApprovalRow>();
  for (const row of baseline.rows) {
    if (baselineById.has(row.id)) fail(`baseline id 重复：${row.id}`);
    baselineById.set(row.id, row);
  }
  const candidateById = new Map<string, ApprovalRow>();
  for (const row of candidate.rows) {
    if (candidateById.has(row.id)) fail(`candidate id 重复：${row.id}`);
    candidateById.set(row.id, row);
  }
  const missing = [...baselineById.keys()].filter((id) => !candidateById.has(id));
  const extra = [...candidateById.keys()].filter((id) => !baselineById.has(id));
  if (missing.length > 0 || extra.length > 0) {
    fail(`两侧 case id 不一致：missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }

  const cases: ApprovalCaseDiff[] = [];
  for (const baselineRow of baseline.rows) {
    const candidateRow = candidateById.get(baselineRow.id);
    if (!candidateRow) fail(`candidate 缺 case：${baselineRow.id}`);
    assertSameCase(baselineRow, candidateRow);
    const result = compareRow(baselineRow, candidateRow);
    if (result) cases.push(result);
  }
  const failClosedCases = cases.filter((item) => item.failClosed).length;
  return {
    ok: failClosedCases === 0,
    tablesDir: baseline.tablesDir,
    comparedCases: baseline.rows.length,
    changedCases: cases.length,
    failClosedCases,
    cases,
  };
}

function formatValue(value: ApprovalDiffValue): string {
  if (value === null) return '∅';
  if (typeof value === 'boolean') return value ? 'safe' : 'unsafe';
  return value.replace(/\s+/g, ' ');
}

export function formatApprovalDiff(result: ApprovalDiffResult): string {
  const lines = [
    `approval decision diff: cases=${result.comparedCases} changed=${result.changedCases} failClosed=${result.failClosedCases}`,
    `tables: ${result.tablesDir}`,
    '',
  ];
  for (const item of result.cases) {
    lines.push(`${item.failClosed ? 'FAIL' : 'INFO'} ${item.bucket}/${item.id} ${item.tool} ${item.input}`);
    for (const change of item.changes) {
      lines.push(`  ${change.dimension}: ${formatValue(change.baseline)} -> ${formatValue(change.candidate)} [${change.direction}${change.failClosed ? ', fail-closed' : ''}]`);
    }
  }
  if (result.cases.length > 0) lines.push('');
  lines.push(result.ok
    ? 'APPROVAL DIFF: ✅ NO FAIL-CLOSED DRIFT'
    : `APPROVAL DIFF: ❌ FAIL-CLOSED DRIFT (${result.failClosedCases})`);
  return lines.join('\n');
}
