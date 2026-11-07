import { describe, expect, it } from 'vitest';
import { describeTaskBlockedReason } from '../../src/shared/taskReasonLanguage';

// FB-746：V8 运行时异常文案（不一定带 "TypeError:" 前缀）不许作为人话透出，
// 一律判成机器噪音（reason 清空，由 UI 用 category 文案兜底）。
describe('describeTaskBlockedReason — JS 运行时异常识别为机器噪音', () => {
  const machineSamples = [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    'Cannot read properties of null (reading \'className\')',
    'Cannot read property \'map\' of undefined',
    'ValidationError is not a function',
    'renderSidebar is not defined',
    'Unexpected token < in JSON at position 0',
    'Durable Run task-abc123 has no live owner lease',
  ];

  for (const sample of machineSamples) {
    it(`清洗为空：${sample}`, () => {
      const described = describeTaskBlockedReason(sample);
      expect(described.reason).toBe('');
    });
  }

  it('owner lease 文案归到 unknown 类别，交给 i18n 类别文案兜底', () => {
    const described = describeTaskBlockedReason('Durable Run task-abc123 has no live owner lease');
    expect(described.reason).toBe('');
    expect(described.category).toBe('unknown');
  });

  it('人类写的散文不受新 pattern 误伤，保留原文', () => {
    const prose = '子任务在等上一个阶段产出数据，拿到后会自动继续。';
    expect(describeTaskBlockedReason(prose)).toEqual({ reason: prose, category: 'unknown' });
    const englishProse = 'Waiting for the build to finish before starting the next step.';
    expect(describeTaskBlockedReason(englishProse).reason).toBe(englishProse);
  });
});
