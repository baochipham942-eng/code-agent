import { describe, expect, it } from 'vitest';
import { GENERATIVE_UI_PROMPT } from '../../../src/host/prompts/generativeUI';

// GENERATIVE_UI_PROMPT 是 applyOverride 的 live Proxy，断言前先 coerce 成真字符串
const prompt = String(GENERATIVE_UI_PROMPT);

describe('generative_ui 提示词：保留用户手工编辑', () => {
  it('明确告诉模型看到 neo:user-edited 标记要以该版本为基准保留改动', () => {
    expect(prompt).toContain('neo:user-edited');
    // 关键语义：以用户改过的版本为基准 + 保留（而不是仅仅「注意到」）
    expect(prompt).toMatch(/以该版本为基准/);
    expect(prompt).toMatch(/保留用户已改/);
  });

  it('规则挂在 generative_ui 段，不是散落别处', () => {
    const marker = prompt.indexOf('neo:user-edited');
    const section = prompt.indexOf('### 交互式 UI（Generative UI）');
    const nextSection = prompt.indexOf('### 交互式电子表格');
    expect(section).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(section);
    expect(marker).toBeLessThan(nextSection);
  });
});
