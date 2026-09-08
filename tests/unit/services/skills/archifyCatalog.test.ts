import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  findRecommendedRepository,
  getBuiltinSkillCatalogPayload,
  groupRecommendedSkillsByCategory,
  RECOMMENDED_REPOSITORIES,
  RECOMMENDED_SKILLS,
} from '../../../../src/shared/constants/skillCatalog';
import type {
  RecommendedSkillEntry,
  SkillRepository,
} from '../../../../src/shared/contract/skillRepository';

const text = z.string().min(1);
const repositorySchema = z.object({
  id: text,
  name: text,
  url: z.string().url(),
  branch: text,
  skillsPath: text,
  category: z.enum(['core', 'workflow', 'productivity', 'community']),
  recommended: z.boolean(),
  description: text.optional(),
  author: text.optional(),
  stars: z.number().int().nonnegative().optional(),
}).strict() satisfies z.ZodType<SkillRepository>;

const skillSchema = z.object({
  name: text,
  displayName: text,
  description: text,
  category: z.enum([
    'docs-office', 'data-analysis', 'design-creative', 'content-marketing',
    'product', 'research', 'automation', 'development',
  ]),
  repoId: text,
  badge: text.optional(),
  keywords: z.array(text).min(1).optional(),
}).strict() satisfies z.ZodType<RecommendedSkillEntry>;

describe('archify recommended catalog', () => {
  it('conforms to the repository and skill schemas', () => {
    expect(repositorySchema.safeParse(findRecommendedRepository('archify')).success).toBe(true);
    expect(skillSchema.safeParse(RECOMMENDED_SKILLS.find((skill) => skill.name === 'archify')).success).toBe(true);
  });

  it('resolves the skill repoId to the installable upstream repository', () => {
    const skill = RECOMMENDED_SKILLS.find((entry) => entry.name === 'archify');
    expect(skill).toBeDefined();
    expect(findRecommendedRepository(skill!.repoId)).toMatchObject({
      id: 'archify',
      url: 'https://github.com/tt-a1i/archify',
      branch: 'main',
      skillsPath: '.',
      recommended: true,
    });
  });

  it('has one repository id and one skill name without catalog collisions', () => {
    const repositoryIds = RECOMMENDED_REPOSITORIES.map((repo) => repo.id);
    const skillNames = RECOMMENDED_SKILLS.map((skill) => skill.name);
    expect(repositoryIds.filter((id) => id === 'archify')).toHaveLength(1);
    expect(skillNames.filter((name) => name === 'archify')).toHaveLength(1);
    expect(new Set(repositoryIds).size).toBe(repositoryIds.length);
    expect(new Set(skillNames).size).toBe(skillNames.length);
  });

  it('uses the existing repository fields without an unmaintained star snapshot', () => {
    const repository = findRecommendedRepository('archify');
    expect(repository).not.toHaveProperty('stars');
    for (const existingId of ['superpowers', 'composio-skills', 'second-brain-skills']) {
      expect(Object.keys(repository!).sort()).toEqual(Object.keys(findRecommendedRepository(existingId)!).sort());
    }
  });

  it('reaches the shared catalog payload and development discovery group', () => {
    const catalog = getBuiltinSkillCatalogPayload();
    expect(catalog.repositories.find((repo) => repo.id === 'archify')).toEqual(findRecommendedRepository('archify'));
    expect(groupRecommendedSkillsByCategory(catalog).find((group) => group.category.id === 'development')?.skills).toContainEqual(
      expect.objectContaining({ name: 'archify', repoId: 'archify', category: 'development' }),
    );
  });
});
