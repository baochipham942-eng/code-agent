// AI 大纲：prompt 构造 + 空 topic 守卫单测（真 LLM 调用付费，不在单测内触发）。
import { describe, expect, it } from 'vitest';
import { buildOutlinePrompt, buildAiOutline } from '../../../../src/main/services/design/slidesAiOutline';

describe('buildOutlinePrompt', () => {
  it('含主题、页数与 Markdown 格式约束', () => {
    const p = buildOutlinePrompt('AI 编程助手', 8);
    expect(p).toContain('AI 编程助手');
    expect(p).toContain('8');
    expect(p).toContain('# 封面标题');
    expect(p).toContain('## 页面标题');
    expect(p).toContain('- 要点');
  });
});

describe('buildAiOutline', () => {
  it('空 topic 抛可读错误（不触发任何模型调用）', async () => {
    await expect(buildAiOutline('   ')).rejects.toThrow(/主题/);
  });
});
