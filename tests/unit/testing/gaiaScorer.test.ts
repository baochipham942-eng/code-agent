// ============================================================================
// GAIA 判分器 — quasi-exact match（对齐官方 question_scorer 语义）
// ============================================================================
// 外部锚点一期：GAIA validation 的判分是确定性字符串/数字比对
// （deterministic_assertion 桶）。语义对齐官方 scorer：
//   - 真值是数字 → 模型答案去 $/%/, 后 float 比对
//   - 真值含 , 或 ; → 按分隔符拆列表逐项比（数字项走数字逻辑）
//   - 其余 → 去空白+小写（+去标点）后精确比对
// 答案提取：约定模型以 "FINAL ANSWER: X" 结尾，取最后一次出现。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  extractFinalAnswer,
  gaiaQuestionScorer,
} from '../../../src/host/testing/gaiaScorer';
import { runAssertions } from '../../../src/host/testing/assertionEngine';

describe('extractFinalAnswer', () => {
  it('取最后一次 FINAL ANSWER 后的内容并去首尾空白', () => {
    const text = '推理过程…\nFINAL ANSWER: 草稿\n再想想…\nFINAL ANSWER:  17 ';
    expect(extractFinalAnswer(text)).toBe('17');
  });

  it('大小写不敏感', () => {
    expect(extractFinalAnswer('blah\nfinal answer: Paris')).toBe('Paris');
  });

  it('没有标记 → null', () => {
    expect(extractFinalAnswer('我觉得答案是 17')).toBeNull();
  });
});

describe('gaiaQuestionScorer', () => {
  it('数字真值：去 $ % 逗号后 float 比对', () => {
    expect(gaiaQuestionScorer('17', '17')).toBe(true);
    expect(gaiaQuestionScorer('$1,234', '1234')).toBe(true);
    expect(gaiaQuestionScorer('56%', '56')).toBe(true);
    expect(gaiaQuestionScorer('17.0', '17')).toBe(true);
    expect(gaiaQuestionScorer('18', '17')).toBe(false);
    expect(gaiaQuestionScorer('about 17', '17')).toBe(false); // 官方语义：非纯数字解析失败
  });

  it('列表真值：逐项比对，长度不等即错', () => {
    expect(gaiaQuestionScorer('a, b, 3', 'a, b, 3')).toBe(true);
    expect(gaiaQuestionScorer('A , B, 3.0', 'a, b, 3')).toBe(true);
    expect(gaiaQuestionScorer('a, b', 'a, b, 3')).toBe(false);
    expect(gaiaQuestionScorer('a; b; 4', 'a; b; 3')).toBe(false);
  });

  it('字符串真值：去空白小写去标点后比对', () => {
    expect(gaiaQuestionScorer('Right Whale', 'right whale')).toBe(true);
    expect(gaiaQuestionScorer('right-whale.', 'right whale')).toBe(true);
    expect(gaiaQuestionScorer('blue whale', 'right whale')).toBe(false);
  });

  it('空/缺失答案 → false', () => {
    expect(gaiaQuestionScorer('', 'x')).toBe(false);
    expect(gaiaQuestionScorer(null, 'x')).toBe(false);
  });
});

describe('assertionEngine 接线（expect.final_answer）', () => {
  const ctx = (responses: string[]) => ({
    toolExecutions: [],
    responses,
    errors: [],
    turnCount: 1,
    workingDirectory: '/tmp',
  });

  it('响应带正确 FINAL ANSWER → pass', async () => {
    const result = await runAssertions({ final_answer: '17' }, ctx([
      '让我算一下…', '算完了。\nFINAL ANSWER: 17',
    ]));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('FINAL ANSWER 错 → fail', async () => {
    const result = await runAssertions({ final_answer: '17' }, ctx(['FINAL ANSWER: 42']));
    expect(result.passed).toBe(false);
  });

  it('没有 FINAL ANSWER 标记 → fail 且失败信息指明格式问题', async () => {
    const result = await runAssertions({ final_answer: '17' }, ctx(['答案是 17']));
    expect(result.passed).toBe(false);
    expect(result.failures[0].message).toContain('FINAL ANSWER');
  });

  it('计入声明断言数（不落 self_check 桶）', async () => {
    const result = await runAssertions({ final_answer: '17' }, ctx(['FINAL ANSWER: 17']));
    expect(result.totalAssertions).toBe(1);
  });
});
