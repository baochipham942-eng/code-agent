// ============================================================================
// 方法论 skill 收编（roadmap 2.3）— superpowers (MIT) via MiMoCode
// ============================================================================
// 验收：skill 列表可见可触发（builtin 集合内、userInvocable、铁律原文保留）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { getBuiltinSkills } from '../../../src/main/services/skills/builtinSkills';

const METHODOLOGY_SKILLS = ['brainstorm', 'tdd', 'debug', 'verify', 'merge', 'work-review'];

describe('methodology builtin skills (roadmap 2.3)', () => {
  const skills = getBuiltinSkills();

  it('registers all six methodology skills as user-invocable builtins', () => {
    for (const name of METHODOLOGY_SKILLS) {
      const skill = skills.find((s) => s.name === name);
      expect(skill, `missing builtin skill: ${name}`).toBeDefined();
      expect(skill!.userInvocable).toBe(true);
      expect(skill!.source).toBe('builtin');
      expect(skill!.promptContent.length).toBeGreaterThan(500);
    }
  });

  it('keeps the superpowers iron laws verbatim', () => {
    const byName = (n: string) => skills.find((s) => s.name === n)!;
    expect(byName('tdd').promptContent).toContain('NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST');
    expect(byName('debug').promptContent).toContain('NO FIXES WITHOUT ROOT CAUSE');
    expect(byName('verify').promptContent).toContain('Evidence before claims');
  });

  it('carries MIT attribution for the adapted content', () => {
    for (const name of METHODOLOGY_SKILLS) {
      const skill = skills.find((s) => s.name === name);
      expect(skill?.license, `${name} missing license`).toMatch(/MIT/);
    }
  });

  it('does not collide with the existing task-style review skill', () => {
    const reviews = skills.filter((s) => s.name === 'review');
    expect(reviews.length).toBe(1); // 既有任务型 review 不受影响
  });
});
