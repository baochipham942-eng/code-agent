import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_REVIEW_DIMENSIONS } from '../../../src/host/testing/judge/dimensions';
import { getAiReviewPrompt } from '../../../src/host/testing/judge/dimensionJudge';

// 标注规范 §2 的评审问题必须与判官提示词逐字一致——判官是「原样注入」不是转述。
// 改任一边这里就红，逼人两边一起改并升规范版本。
describe('docs/eval/annotation-guideline.md ↔ 判官提示词', () => {
  const guideline = readFileSync(path.resolve(process.cwd(), 'docs/eval/annotation-guideline.md'), 'utf8');
  const rows = new Map<string, string>();
  for (const match of guideline.matchAll(/^\| (\w+) \| (.+?) \| .+? \|$/gm)) rows.set(match[1], match[2].trim());

  it('五个维度都在规范表里', () => {
    for (const dimension of AI_REVIEW_DIMENSIONS) expect(rows.has(dimension), dimension).toBe(true);
  });

  it('每条评审问题原样出现在对应维度的判官提示词里', () => {
    for (const dimension of AI_REVIEW_DIMENSIONS) {
      expect(getAiReviewPrompt(dimension), dimension).toContain(rows.get(dimension));
    }
  });

  it('规范写明三值判定与弃权转人工，和判官提示词口径一致', () => {
    expect(guideline).toContain('是 / 否 / 无法确定');
    expect(getAiReviewPrompt('task_completed')).toContain('无法确定');
  });
});
