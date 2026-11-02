import { describe, expect, it } from 'vitest';
import {
  formatDelegateSessionSummary,
  parseOutcomeLine,
  summarizeDelegateSessionOutcomes,
} from '../../../scripts/acceptance/delegate-session-rejection-summary.mjs';

// ADR-072 E6 汇总脚本的钉子：PASS 判据 = total>=500 AND rejected>0 AND 拒绝码>=2。
// fixture 行形状来自真 logger 的 writeToFile（message + data[0]）。
const outcomeLine = (outcome: string, code: string, gate: string, action = 'delegate_existing') =>
  JSON.stringify({
    timestamp: '2026-10-30T08:00:00.000Z',
    level: 'info',
    context: 'DelegateSession',
    message: '[DelegateSession] outcome',
    data: [{ outcome, code, gate, action }],
  });

const rejectionLine = (code: string, gate: string, action?: string) => outcomeLine('rejected', code, gate, action);

describe('delegate-session-rejection-summary (ADR-072 E6)', () => {
  it('f1) 600 lines / 3 rejection codes → PASS', () => {
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      if (i % 3 === 0) lines.push(rejectionLine('target_busy', 'G4'));
      else if (i % 3 === 1) lines.push(rejectionLine('candidate_set_stale', 'G3', 'delegate_existing'));
      else lines.push(rejectionLine('invalid_call', 'none', 'unknown'));
    }
    const report = summarizeDelegateSessionOutcomes([lines.join('\n')]);
    expect(report.total).toBe(600);
    expect(report.rejected).toBe(600);
    expect(report.distinctCodes).toBe(3);
    expect(report.verdict).toBe('PASS');
    expect(report.missing).toEqual([]);
    const output = formatDelegateSessionSummary(report);
    expect(output).toContain('code x gate:');
    expect(output).toContain('candidate_set_stale × G3: 200');
    expect(output).toContain('target_busy × G4: 200');
    expect(output).toContain('invalid_call × none: 200');
    expect(output.trimEnd().endsWith('E6: PASS')).toBe(true);
  });

  it('f2) 499 lines → PENDING naming the missing total', () => {
    const lines = Array.from({ length: 499 }, () => rejectionLine('target_busy', 'G4'));
    const report = summarizeDelegateSessionOutcomes([lines.join('\n')]);
    expect(report.total).toBe(499);
    expect(report.distinctCodes).toBe(1);
    expect(report.verdict).toBe('PENDING');
    expect(report.missing).toContain('total 499 < 500');
    expect(formatDelegateSessionSummary(report)).toContain('E6: PENDING');
  });

  it('f3) 600 lines all ok → PENDING naming the missing rejections', () => {
    const lines = Array.from({ length: 600 }, () => outcomeLine('ok', 'ok', 'none', 'create_new'));
    const report = summarizeDelegateSessionOutcomes([lines.join('\n')]);
    expect(report.total).toBe(600);
    expect(report.ok).toBe(600);
    expect(report.rejected).toBe(0);
    expect(report.verdict).toBe('PENDING');
    expect(report.missing).toContain('no rejections recorded');
    expect(formatDelegateSessionSummary(report)).toContain('E6: PENDING');
  });

  it('skips non-JSON and non-outcome lines, and tolerates malformed outcome payloads', () => {
    const log = [
      'not json at all',
      JSON.stringify({ timestamp: 'x', level: 'info', message: 'other log line', data: [{}] }),
      outcomeLine('rejected', 'target_busy', 'G4'),
      JSON.stringify({ message: '[DelegateSession] outcome', data: [{ outcome: 'rejected' }] }), // 缺 code → 忽略
      '',
    ].join('\n');
    const report = summarizeDelegateSessionOutcomes([log]);
    expect(report.total).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.codeGate).toEqual({ 'target_busy\tG4': { code: 'target_busy', gate: 'G4', count: 1 } });
    expect(parseOutcomeLine('garbage')).toBeNull();
  });

  it('aggregates across multiple log files', () => {
    const report = summarizeDelegateSessionOutcomes([
      [rejectionLine('target_busy', 'G4'), rejectionLine('ambiguous', 'G3')].join('\n'),
      [rejectionLine('target_busy', 'G4')].join('\n'),
    ]);
    expect(report.total).toBe(3);
    expect(report.distinctCodes).toBe(2);
    expect(report.codeGate['target_busy\tG4'].count).toBe(2);
  });
});
