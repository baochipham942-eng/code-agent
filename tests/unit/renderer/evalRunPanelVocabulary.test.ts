import { describe, expect, it } from 'vitest';
import { evalCenterEn, evalCenterZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evaluationCenter';
import { evalRunPanelEn, evalRunPanelZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evalRunPanel';
import { evalScorersEn, evalScorersZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evalScorers';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}

describe('跑分面板用户词表', () => {
  it('四个挂载面都不出现 §7.3 左列与 H4 禁用主文案', () => {
    const zhSurfaces = [
      evalRunPanelZh.runPanel,
      evalCenterZh.evalCenter.runPanel,
      evalScorersZh.scorers,
      evalCenterZh.evalCenter.scorers,
    ];
    const enSurfaces = [
      evalRunPanelEn.runPanel,
      evalCenterEn.evalCenter.runPanel,
      evalScorersEn.scorers,
      evalCenterEn.evalCenter.scorers,
    ];
    const forbiddenZh = [
      '钉为基线', '口径', '身份戳', '硬化', '未硬化', '假跑', '标废', '已作废',
      '能力分母', '不进分母', '回流', '收成题目', '溯源', '两臂', 'decisive',
      'headline', 'llm_judge', 'human 桶', 'held-in', 'held-out', 'control', 'smoke',
      'infra_excluded', 'pass^k', 'Δ', 'mock', 'real', '失败码', '题面',
      'spawn', 'NDJSON', '沙箱', '分母', 'p 值',
    ];
    for (const surface of zhSurfaces) {
      const copy = strings(surface).join('\n');
      for (const word of forbiddenZh) expect(copy).not.toContain(word);
    }
    for (const surface of enSurfaces) {
      const copy = strings(surface).join('\n').toLowerCase();
      for (const word of ['ndjson', 'spawn', 'decisive', 'pass^k']) expect(copy).not.toContain(word);
    }
  });
});
