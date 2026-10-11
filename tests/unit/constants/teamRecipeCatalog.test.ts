import { describe, expect, it } from 'vitest';
import { TEAM_RECIPES } from '../../../src/shared/constants/teamRecipeCatalog';

describe('teamRecipeCatalog', () => {
  it('每个出厂专家团至少带 1 条非空快捷句，用户才知道能开口问什么', () => {
    for (const recipe of TEAM_RECIPES) {
      const prompts = recipe.quickPrompts ?? [];
      expect(
        prompts.length,
        `${recipe.id}: quickPrompts 为空`,
      ).toBeGreaterThanOrEqual(1);
      for (const prompt of prompts) {
        expect(prompt.trim().length, `${recipe.id}: 快捷句是空白串`).toBeGreaterThan(0);
      }
    }
  });

  it('快捷句是自然整句，不暴露 {topic} 占位符给用户', () => {
    for (const recipe of TEAM_RECIPES) {
      for (const prompt of recipe.quickPrompts ?? []) {
        expect(prompt, `${recipe.id}: 快捷句含 {topic} 占位符`).not.toContain('{topic}');
      }
    }
  });
});
