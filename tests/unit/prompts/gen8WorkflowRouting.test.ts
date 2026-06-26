import { describe, it, expect } from 'vitest';
import { TOOLS_PROMPT } from '../../../src/host/prompts/base';

// P3c 回归守卫：base tools prompt 必须保留 /workflow → workflow 工具的路由 carve-out（否则模型会把
// /workflow 当普通 /xxx 路由到 Skill，触发不了 workflow 工具）。
// TOOLS_PROMPT 是 live-prompt 对象（registry.makeLivePrompt，String() 时才求值），故先 coerce。
const prompt = String(TOOLS_PROMPT);

describe('base tools /workflow routing carve-out', () => {
  it('mentions /workflow as a workflow-tool exception to the Skill routing rule', () => {
    expect(prompt).toContain('/workflow');
    expect(prompt).toContain('workflow');
  });

  it('still keeps the general /xxx → Skill rule', () => {
    expect(prompt).toMatch(/\/xxx.*Skill/);
  });
});
