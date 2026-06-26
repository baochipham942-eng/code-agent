// AI 大纲：prompt 构造 + 空 topic 守卫单测（真 LLM 调用付费，不在单测内触发）。
import { describe, expect, it } from 'vitest';
import { buildOutlinePrompt, buildAiOutline } from '../../../../src/host/services/design/slidesAiOutline';

describe('buildOutlinePrompt', () => {
  it('含主题、页数与 Markdown 格式约束', () => {
    const p = buildOutlinePrompt('AI 编程助手', 8);
    expect(p).toContain('AI 编程助手');
    expect(p).toContain('8');
    expect(p).toContain('# 封面标题');
    expect(p).toContain('## 页面标题');
    expect(p).toContain('- 要点');
  });

  it('brief 注入：把 agent 调研要点喂进 prompt 接地气（要求据此生成、不编造）', () => {
    const p = buildOutlinePrompt(
      'Code Agent 行业趋势',
      5,
      'AI代码工具市场93.5亿美元; 五强Cursor/Claude Code/Copilot; 84%开发者采用率',
    );
    expect(p).toContain('AI代码工具市场93.5亿美元');
    expect(p).toContain('84%开发者采用率');
    // 必须有"据此生成/不要编造"之类的约束，避免 AI 抛开真材料瞎编
    expect(p).toMatch(/据此|优先采用|不要编造|不得编造|基于(以上|这些)/);
  });

  it('无 brief 时向后兼容（不含调研段标记）', () => {
    const p = buildOutlinePrompt('X', 5);
    expect(p).not.toContain('调研要点');
  });
});

describe('buildAiOutline', () => {
  it('空 topic 抛可读错误（不触发任何模型调用）', async () => {
    await expect(buildAiOutline('   ')).rejects.toThrow(/主题/);
  });
});
