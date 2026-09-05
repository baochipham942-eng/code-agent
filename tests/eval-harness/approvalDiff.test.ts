import { describe, expect, it } from 'vitest';
import {
  diffApprovalReports,
  formatApprovalDiff,
} from '../../packages/internal/evaluation-center/scripts/lib/approval-diff';
import type {
  ApprovalEvalReport,
  ApprovalRow,
} from '../../packages/internal/evaluation-center/scripts/lib/approval-eval';

function row(partial: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    bucket: 'dangerous',
    id: 'case-1',
    tool: 'Bash',
    input: './ls',
    expected: 'ask',
    actual: 'ask',
    detail: 'command/unknown',
    isKnownSafeCommand: false,
    riskLevel: 'unknown',
    reason: 'Execute shell command',
    ...partial,
  };
}

function report(rows: ApprovalRow[]): ApprovalEvalReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-05T00:00:00.000Z',
    tablesDir: '/shared/approval-eval',
    ratchet: { benignAskMax: 10, knownGaps: {}, knownOverBlocks: {} },
    gate: {
      ok: true,
      failures: [],
      warnings: [],
      summary: {
        benign: { allow: 0, ask: 0, deny: 0 },
        dangerous: { allow: 0, ask: 1, deny: 0 },
        injection: { allow: 0, ask: 0, deny: 0 },
      },
      benignAsks: 0,
    },
    rows,
  };
}

describe('approval decision diff', () => {
  it('deny → ask fail-closed', () => {
    const result = diffApprovalReports(
      report([row({ actual: 'deny' })]),
      report([row({ actual: 'ask' })]),
    );
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.changes).toContainEqual(expect.objectContaining({
      dimension: 'decision',
      baseline: 'deny',
      candidate: 'ask',
      failClosed: true,
    }));
  });

  it('ask → allow fail-closed', () => {
    const result = diffApprovalReports(
      report([row({ actual: 'ask' })]),
      report([row({ actual: 'allow' })]),
    );
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.changes).toContainEqual(expect.objectContaining({
      dimension: 'decision',
      baseline: 'ask',
      candidate: 'allow',
      failClosed: true,
    }));
  });

  it('unsafe → safe fail-closed，即使最终判决没变也能看见', () => {
    const result = diffApprovalReports(
      report([row({ isKnownSafeCommand: false })]),
      report([row({ isKnownSafeCommand: true })]),
    );
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.changes).toContainEqual({
      dimension: 'isKnownSafeCommand',
      baseline: false,
      candidate: true,
      direction: 'relaxed',
      failClosed: true,
    });
  });

  it('更严方向只报告不阻塞', () => {
    const result = diffApprovalReports(
      report([row({ actual: 'allow', isKnownSafeCommand: true })]),
      report([row({ actual: 'ask', isKnownSafeCommand: false })]),
    );
    expect(result.ok).toBe(true);
    expect(result.failClosedCases).toBe(0);
    expect(result.changedCases).toBe(1);
    expect(result.cases[0]?.changes).toEqual([
      expect.objectContaining({ dimension: 'isKnownSafeCommand', direction: 'tightened', failClosed: false }),
      expect.objectContaining({ dimension: 'decision', direction: 'tightened', failClosed: false }),
    ]);
  });

  it('两侧完全一致时无漂移', () => {
    const baseline = report([row()]);
    const result = diffApprovalReports(baseline, structuredClone(baseline));
    expect(result).toMatchObject({ ok: true, comparedCases: 1, changedCases: 0, failClosedCases: 0, cases: [] });
    expect(formatApprovalDiff(result)).toContain('APPROVAL DIFF: ✅ NO FAIL-CLOSED DRIFT');
  });

  it('riskLevel 与理由改变也进入报告，但不单独阻塞', () => {
    const result = diffApprovalReports(
      report([row({ riskLevel: 'high', reason: 'baseline reason' })]),
      report([row({ riskLevel: 'safe', reason: 'candidate reason' })]),
    );
    expect(result.ok).toBe(true);
    expect(result.cases[0]?.changes).toEqual([
      expect.objectContaining({ dimension: 'riskLevel', baseline: 'high', candidate: 'safe', failClosed: false }),
      expect.objectContaining({ dimension: 'reason', baseline: 'baseline reason', candidate: 'candidate reason', failClosed: false }),
    ]);
  });

  it('两侧题面或表目录不一致时 fail-loud', () => {
    expect(() => diffApprovalReports(
      report([row()]),
      report([row({ input: '/tmp/other' })]),
    )).toThrow(/input 两侧不一致/);

    const candidate = report([row()]);
    candidate.tablesDir = '/other/approval-eval';
    expect(() => diffApprovalReports(report([row()]), candidate)).toThrow(/tablesDir 不一致/);
  });
});
