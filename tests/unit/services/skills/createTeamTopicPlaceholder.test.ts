// ============================================================================
// create-team 不许向用户索要「具体主题」 —— 2026-07-23 真机回归钉
// ----------------------------------------------------------------------------
// 实测：用户提交「/create-team 写一篇微信推文」，模型回问"这篇推文大概写什么主题或方向？"。
// 但成员任务模板里用的是 {topic} 占位，具体主题是**启动配方时**才填的，建配方阶段根本不需要。
// 这一问就是白耗一轮——正是 #602 要消灭的那类空转，只是换了个位置复发。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';

function createTeamPrompt(): string {
  const skill = BUILTIN_SKILLS.find((item) => item.name === 'create-team');
  if (!skill) throw new Error('create-team skill 不存在了——入口或名字被改了，先修这里');
  return skill.promptContent;
}

describe('create-team 的主题占位约定', () => {
  it('提示词明确交代 {topic} 是启动时才填，并禁止追问具体主题', () => {
    const prompt = createTeamPrompt();

    // 先确认拿到的是真提示词，避免空串让后面的断言天然通过
    expect(prompt.length).toBeGreaterThan(200);

    expect(prompt).toContain('{topic}');
    expect(prompt).toContain('不要问用户');
    expect(prompt).toContain('启动配方时');
  });

  it('两条输入路径仍在（别把提示词改坏）', () => {
    const prompt = createTeamPrompt();
    expect(prompt).toContain('一句话建团队');
    expect(prompt).toContain('资料转化');
  });

  it('起草前先取权威名册这条也仍在（#607 的约定）', () => {
    expect(createTeamPrompt()).toContain('list_experts');
  });
});
