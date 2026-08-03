import { describe, expect, it } from 'vitest';

import { needsLlmIntentClassification } from '../../../src/host/routing/intentClassifier';

// 分类那一问走 quick model，在真正开始干活之前、每轮都要付（真机 2026-08-01 实测 2.3-4s）。
// 但不能按长度砍——见下面第二条：短句恰恰是最需要分类的。
describe('needsLlmIntentClassification', () => {
  it('寒暄/确认/纯数字没有语义可分，不为它等一次小模型', () => {
    for (const text of ['你好', 'hi', 'OK', '好的', '嗯嗯', '谢谢', '1', '2026', '。。。', '  ']) {
      expect(needsLlmIntentClassification(text), text).toBe(false);
    }
  });

  // 这条是这个门的红线：8 个字，比「你好」长不了多少，却是最需要分类的一种——
  // 它的 references_past_context 决定要不要把历史记忆注进去，砍掉等于让模型突然失忆。
  it('短但有指代语义的必须照旧分类', () => {
    expect(needsLlmIntentClassification('把那个方案往下做')).toBe(true);
    expect(needsLlmIntentClassification('继续改')).toBe(true);
    expect(needsLlmIntentClassification('再来一版')).toBe(true);
  });

  it('正常表述照旧分类', () => {
    expect(needsLlmIntentClassification('帮我看看小米汽车这两年的销量走势')).toBe(true);
    expect(needsLlmIntentClassification('小米汽车怎么样？')).toBe(true);
  });
});

describe('classifyIntent 的快模型开关', () => {
  it('allowQuickModel=false 时不调快模型，退回关键词档的结论', async () => {
    const { classifyIntent } = await import('../../../src/host/routing/intentClassifier');
    // 关键词档命中不了的表述，正常会去问快模型；关掉开关后应当直接 general
    const result = await classifyIntent('把那个方案往下做', {} as never, { allowQuickModel: false });
    expect(result).toEqual({ intent: 'general', references_past_context: false });
  });
});
