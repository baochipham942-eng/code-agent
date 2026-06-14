import { describe, expect, it } from 'vitest';
import {
  ALMA_BUNDLED_SKILL_MAPPINGS,
  RECOMMENDED_REPOSITORIES,
  RECOMMENDED_SKILLS,
  SKILL_CATEGORIES,
  SKILL_ROLE_BUNDLES,
  findRecommendedRepository,
  groupRecommendedSkillsByCategory,
} from '../../../../src/shared/constants/skillCatalog';
import { BUILTIN_REPO_ID } from '../../../../src/shared/contract/skillRepository';
import { getBuiltinSkills } from '../../../../src/main/services/skills/builtinSkills';
import {
  getBundleMissingRepoIds,
  isBundleReady,
} from '../../../../src/renderer/components/features/settings/tabs/SkillsDiscoverTab';

describe('recommended skill catalog integrity', () => {
  const repoIds = new Set(RECOMMENDED_REPOSITORIES.map((repo) => repo.id));
  const categoryIds = new Set(SKILL_CATEGORIES.map((category) => category.id));
  const builtinSkillNames = new Set(getBuiltinSkills().map((skill) => skill.name));

  it('has unique repository ids', () => {
    expect(repoIds.size).toBe(RECOMMENDED_REPOSITORIES.length);
  });

  it('has unique recommended skill names', () => {
    const names = RECOMMENDED_SKILLS.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every recommended skill references an existing repository or builtin', () => {
    for (const skill of RECOMMENDED_SKILLS) {
      const valid = skill.repoId === BUILTIN_REPO_ID || repoIds.has(skill.repoId);
      expect(valid, `skill "${skill.name}" references unknown repo "${skill.repoId}"`).toBe(true);
    }
  });

  it('every builtin recommended skill exists in builtinSkills', () => {
    for (const skill of RECOMMENDED_SKILLS) {
      if (skill.repoId === BUILTIN_REPO_ID) {
        expect(
          builtinSkillNames.has(skill.name),
          `builtin skill "${skill.name}" not found in builtinSkills.ts`
        ).toBe(true);
      }
    }
  });

  it('every recommended skill uses a defined category', () => {
    for (const skill of RECOMMENDED_SKILLS) {
      expect(
        categoryIds.has(skill.category),
        `skill "${skill.name}" uses unknown category "${skill.category}"`
      ).toBe(true);
    }
  });

  it('every bundle skill references an existing repository or builtin', () => {
    for (const bundle of SKILL_ROLE_BUNDLES) {
      for (const skill of bundle.skills) {
        const valid = skill.repoId === BUILTIN_REPO_ID || repoIds.has(skill.repoId);
        expect(
          valid,
          `bundle "${bundle.id}" skill "${skill.name}" references unknown repo "${skill.repoId}"`
        ).toBe(true);
      }
    }

    // bundle 内引用的内置 skill 也必须真实存在
    for (const bundle of SKILL_ROLE_BUNDLES) {
      for (const skill of bundle.skills) {
        if (skill.repoId === BUILTIN_REPO_ID) {
          expect(
            builtinSkillNames.has(skill.name),
            `bundle "${bundle.id}" builtin skill "${skill.name}" not found in builtinSkills.ts`
          ).toBe(true);
        }
      }
    }
  });

  it('has unique bundle ids', () => {
    const ids = SKILL_ROLE_BUNDLES.map((bundle) => bundle.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups skills by category preserving SKILL_CATEGORIES order', () => {
    const groups = groupRecommendedSkillsByCategory();
    // 每个分组非空
    for (const group of groups) {
      expect(group.skills.length).toBeGreaterThan(0);
    }
    // 顺序与 SKILL_CATEGORIES 一致
    const groupOrder = groups.map((group) => group.category.id);
    const expectedOrder = SKILL_CATEGORIES.filter((category) =>
      RECOMMENDED_SKILLS.some((skill) => skill.category === category.id)
    ).map((category) => category.id);
    expect(groupOrder).toEqual(expectedOrder);
  });

  it('findRecommendedRepository resolves all referenced repos', () => {
    for (const repo of RECOMMENDED_REPOSITORIES) {
      expect(findRecommendedRepository(repo.id)).toEqual(repo);
    }
    expect(findRecommendedRepository('nonexistent')).toBeUndefined();
  });

  it('maps every Alma bundled skill to a code-agent recommendation outcome', () => {
    const names = ALMA_BUNDLED_SKILL_MAPPINGS.map((mapping) => mapping.name);

    expect(names).toEqual([
      'browser',
      'computer-use',
      'daily-report',
      'discord',
      'file-manager',
      'image-gen',
      'memory-management',
      'music-gen',
      'music-listener',
      'notebook',
      'plan-mode',
      'programmatic-tools',
      'reactions',
      'scheduler',
      'screenshot',
      'self-management',
      'self-reflection',
      'selfie',
      'send-file',
      'skill-hub',
      'skill-search',
      'system-info',
      'tasks',
      'telegram',
      'thread-management',
      'todo',
      'travel',
      'twitter-media',
      'video-reader',
      'voice',
      'web-fetch',
      'web-search',
      'xiaohongshu-cli',
    ]);
    expect(new Set(names).size).toBe(33);
    expect(ALMA_BUNDLED_SKILL_MAPPINGS.every((mapping) => mapping.codeAgentSurface && mapping.rationale)).toBe(true);
  });
});

describe('bundle install helpers', () => {
  const bundleWithMixedSources = SKILL_ROLE_BUNDLES.find((bundle) =>
    bundle.skills.some((skill) => skill.repoId !== BUILTIN_REPO_ID)
  )!;

  it('bundle is not ready when source repos are missing', () => {
    expect(isBundleReady(bundleWithMixedSources, new Set())).toBe(false);
  });

  it('bundle is ready when all source repos are installed', () => {
    const allRepoIds = new Set(
      bundleWithMixedSources.skills
        .map((skill) => skill.repoId)
        .filter((repoId) => repoId !== BUILTIN_REPO_ID)
    );
    expect(isBundleReady(bundleWithMixedSources, allRepoIds)).toBe(true);
  });

  it('missing repo ids are deduplicated and exclude builtin', () => {
    const missing = getBundleMissingRepoIds(bundleWithMixedSources, new Set());
    expect(new Set(missing).size).toBe(missing.length);
    expect(missing).not.toContain(BUILTIN_REPO_ID);
    for (const repoId of missing) {
      expect(findRecommendedRepository(repoId)).toBeDefined();
    }
  });
});
