import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateApprovalGate,
  loadApprovalRatchet,
  loadApprovalTables,
  parseApprovalTable,
  runApprovalEval,
  type ApprovalRatchet,
  type ApprovalRow,
} from '../../packages/internal/evaluation-center/scripts/lib/approval-eval';

const TABLES_DIR = path.resolve(__dirname, '../fixtures/approval-eval');

function row(partial: Partial<ApprovalRow> & Pick<ApprovalRow, 'bucket' | 'id' | 'actual'>): ApprovalRow {
  return { tool: 'Bash', input: partial.id, expected: partial.bucket === 'benign' ? 'allow' : 'ask', detail: '', ...partial };
}

const emptyRatchet: ApprovalRatchet = { benignAskMax: 0, knownGaps: {}, knownOverBlocks: {} };

describe('approval decision gate（判据本身）', () => {
  it('dangerous / injection 被放行即红（false-allows=0 硬门）', () => {
    const gate = evaluateApprovalGate([
      row({ bucket: 'dangerous', id: 'd1', actual: 'allow' }),
      row({ bucket: 'injection', id: 'i1', actual: 'deny' }),
    ], emptyRatchet);
    expect(gate.ok).toBe(false);
    expect(gate.failures).toEqual([expect.stringContaining('false-allow：dangerous/d1')]);
  });

  it('已知缺口挂了单号只警告不红；缺口消失后棘轮陈旧即红', () => {
    const ratchet: ApprovalRatchet = { ...emptyRatchet, knownGaps: { d1: 'N-TICKET' } };
    const stillOpen = evaluateApprovalGate([row({ bucket: 'dangerous', id: 'd1', actual: 'allow' })], ratchet);
    expect(stillOpen.ok).toBe(true);
    expect(stillOpen.warnings).toEqual([expect.stringContaining('N-TICKET')]);

    const fixed = evaluateApprovalGate([row({ bucket: 'dangerous', id: 'd1', actual: 'ask' })], ratchet);
    expect(fixed.ok).toBe(false);
    expect(fixed.failures).toEqual([expect.stringContaining('knownGaps 里的 d1 已不再被放行')]);
  });

  it('benign 被拒即红，除非挂了 knownOverBlocks 单号；ask 数超棘轮即红', () => {
    const denied = evaluateApprovalGate([row({ bucket: 'benign', id: 'b1', actual: 'deny' })], emptyRatchet);
    expect(denied.ok).toBe(false);
    expect(denied.failures).toEqual([expect.stringContaining('benign 被拒：b1')]);

    const tolerated = evaluateApprovalGate(
      [row({ bucket: 'benign', id: 'b1', actual: 'deny' })],
      { ...emptyRatchet, knownOverBlocks: { b1: 'N-TICKET' } },
    );
    expect(tolerated.ok).toBe(true);

    const overCautious = evaluateApprovalGate(
      [row({ bucket: 'benign', id: 'b1', actual: 'ask' }), row({ bucket: 'benign', id: 'b2', actual: 'ask' })],
      { ...emptyRatchet, benignAskMax: 1 },
    );
    expect(overCautious.ok).toBe(false);
    expect(overCautious.failures).toEqual([expect.stringContaining('ask=2 超过棘轮上限 1')]);
    expect(overCautious.benignAsks).toBe(2);

    const productApprovedAsk = evaluateApprovalGate(
      [row({ bucket: 'benign', id: 'b3', actual: 'ask', expected: 'ask' })],
      emptyRatchet,
    );
    expect(productApprovedAsk.ok).toBe(true);
    expect(productApprovedAsk.benignAsks).toBe(0);
  });

  it('expectedRule 防止显式 ask 退化成 fallback ask', () => {
    const missingRule = evaluateApprovalGate([
      row({
        bucket: 'benign',
        id: 'benign-git-push-feature',
        actual: 'ask',
        expected: 'ask',
        expectedRule: 'B1: git_remote_or_credential_write',
        traceRule: 'fallback',
      }),
    ], emptyRatchet);

    expect(missingRule.ok).toBe(false);
    expect(missingRule.failures).toEqual([
      expect.stringContaining('benign-git-push-feature 未命中确定性审批规则'),
    ]);
  });

  it('决策表格式错误 fail-loud（expected 非法 / 缺 id）', () => {
    expect(() => parseApprovalTable('benign', 'cases:\n  - { id: x, tool: Bash, params: { command: ls }, expected: maybe }\n', 't')).toThrow(/expected 必须是/);
    expect(() => parseApprovalTable('benign', 'cases:\n  - { tool: Bash, params: { command: ls }, expected: allow }\n', 't')).toThrow(/缺 id/);
  });
});

describe('approval decision tables（真实决策路径，零模型零副作用）', () => {
  it('三桶表过门：dangerous/injection 零放行（已知缺口除外）、benign 零拒（已知过度拦除外）、ask 不超棘轮', async () => {
    const tables = loadApprovalTables(TABLES_DIR);
    const ratchet = loadApprovalRatchet(path.join(TABLES_DIR, 'ratchet.json'));
    const rows = await runApprovalEval({ tables });
    expect(rows.length).toBe(tables.reduce((n, t) => n + t.cases.length, 0));
    const gate = evaluateApprovalGate(rows, ratchet);
    expect(gate.failures, gate.failures.join('\n')).toEqual([]);
    expect(gate.ok).toBe(true);
    // 桩没被绕过：dangerous 桶里至少有 deny，说明决策真跑到了 validateCommand / 策略层
    expect(gate.summary.dangerous.deny).toBeGreaterThan(0);
  }, 120_000);
});
