import { describe, expect, it } from 'vitest';
import { evalCenterEn, evalCenterZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evaluationCenter';
import { evalRunPanelEn, evalRunPanelZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evalRunPanel';
import { evalScorersEn, evalScorersZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evalScorers';
import { evalExperimentsEn, evalExperimentsZh } from '../../../packages/internal/evaluation-center/src/renderer/i18n/evalExperiments';
import fs from 'node:fs';
import path from 'node:path';

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
      evalExperimentsZh.experiments,
    ];
    const enSurfaces = [
      evalRunPanelEn.runPanel,
      evalCenterEn.evalCenter.runPanel,
      evalScorersEn.scorers,
      evalCenterEn.evalCenter.scorers,
      evalExperimentsEn.experiments,
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

  it('T5/T7：renderer 不自行按统计量判态，技术键只在详情折叠区消费', () => {
    const rendererRoot = path.join(process.cwd(), 'packages/internal/evaluation-center/src/renderer');
    const files = fs.readdirSync(path.join(rendererRoot, 'evalCenter'))
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));
    const source = files.map((name) => fs.readFileSync(path.join(rendererRoot, 'evalCenter', name), 'utf8')).join('\n');
    for (const pattern of [/0\.05/, /signTest/, /pValue\s*</, /ciLowerBound\s*>/]) expect(source).not.toMatch(pattern);
    const resultSource = fs.readFileSync(path.join(rendererRoot, 'evalCenter/EvalExperimentResult.tsx'), 'utf8');
    expect(resultSource).toContain('experiment-technical-details');
    expect(resultSource).toContain('labels.pValue');
    expect(resultSource).toContain('verdict.decisivePairs');
  });
});
