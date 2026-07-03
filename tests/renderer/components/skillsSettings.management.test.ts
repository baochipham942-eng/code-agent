// ============================================================================
// SkillsSettings 分组/摘要/过滤工具函数测试
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';
import type { LocalSkillLibrary } from '../../../src/shared/contract/skillRepository';
import {
  buildInstalledSkillGroups,
  buildInstalledSkillSummary,
  filterSkillGroups,
  findLibraryForSkill,
} from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';
import { zh } from '../../../src/renderer/i18n/zh';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function makeSkill(overrides: Partial<ParsedSkill> & Pick<ParsedSkill, 'name' | 'source'>): ParsedSkill {
  return {
    description: `${overrides.name} description`,
    promptContent: '',
    basePath: `/skills/${overrides.name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    ...overrides,
  };
}

const coreLibrary: LocalSkillLibrary = {
  repoId: 'core',
  repoName: 'Core Skills',
  localPath: '/home/.code-agent/skills/core',
  downloadedAt: 1,
  lastUpdated: 2,
  version: 'abc123',
  skills: [],
};

const communityLibrary: LocalSkillLibrary = {
  repoId: 'community',
  repoName: 'Community Skills',
  localPath: '/home/.code-agent/skills/community',
  downloadedAt: 1,
  lastUpdated: 2,
  skills: [],
};

const builtinSkill = makeSkill({ name: 'pdf', source: 'builtin' });
const cloudSkill = makeSkill({ name: 'xlsx', source: 'cloud' });
const projectSkill = makeSkill({
  name: 'research',
  source: 'project',
  basePath: '/repo/.code-agent/skills/research',
});
const userSkill = makeSkill({
  name: 'my-tool',
  source: 'user',
  basePath: '/home/.claude/skills/my-tool',
});
const coreLibrarySkill = makeSkill({
  name: 'slides',
  source: 'library',
  basePath: '/home/.code-agent/skills/core/skills/slides',
  enabled: false,
});
const orphanLibrarySkill = makeSkill({
  name: 'lost-skill',
  source: 'library',
  basePath: '/home/.code-agent/skills/removed-repo/skills/lost-skill',
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('findLibraryForSkill', () => {
  it('matches library skills by basePath prefix', () => {
    expect(findLibraryForSkill(coreLibrarySkill, [coreLibrary, communityLibrary])).toBe(coreLibrary);
    expect(findLibraryForSkill(orphanLibrarySkill, [coreLibrary, communityLibrary])).toBeUndefined();
  });

  it('returns undefined for non-library skills', () => {
    expect(findLibraryForSkill(builtinSkill, [coreLibrary])).toBeUndefined();
    expect(findLibraryForSkill(projectSkill, [coreLibrary])).toBeUndefined();
  });
});

describe('buildInstalledSkillGroups', () => {
  it('groups skills by source: builtin+cloud / project / user / per-library', () => {
    const groups = buildInstalledSkillGroups(
      [builtinSkill, cloudSkill, projectSkill, userSkill, coreLibrarySkill],
      [coreLibrary, communityLibrary],
    );

    expect(groups.map((group) => group.key)).toEqual([
      'builtin',
      'project',
      'user',
      'library:community',
      'library:core',
    ]);

    // builtin 组包含 builtin + cloud 来源，按名称排序
    const builtinGroup = groups.find((group) => group.key === 'builtin');
    expect(builtinGroup?.skills.map((skill) => skill.name)).toEqual(['pdf', 'xlsx']);

    // library 组带 repoId（供组头更新/删除操作）
    const coreGroup = groups.find((group) => group.key === 'library:core');
    expect(coreGroup?.repoId).toBe('core');
    expect(coreGroup?.label).toBe('Core Skills');
    expect(coreGroup?.skills.map((skill) => skill.name)).toEqual(['slides']);

    // 已下载但扫描到 0 个 skill 的库也保留组（便于管理）
    const communityGroup = groups.find((group) => group.key === 'library:community');
    expect(communityGroup?.skills).toEqual([]);
  });

  it('collects library skills with no matching library into a fallback group', () => {
    const groups = buildInstalledSkillGroups([orphanLibrarySkill], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'library:unknown',
      kind: 'library',
      label: zh.settings.skills.installed.groupLabels.unknownLibrary,
    });
    expect(groups[0].skills.map((skill) => skill.name)).toEqual(['lost-skill']);
  });

  it('omits empty non-library groups', () => {
    const groups = buildInstalledSkillGroups([builtinSkill], []);
    expect(groups.map((group) => group.key)).toEqual(['builtin']);
  });
});

describe('buildInstalledSkillSummary', () => {
  it('counts totals, libraries, disabled skills and missing dependencies', () => {
    const missingDepsSkill = makeSkill({
      name: 'needs-node',
      source: 'user',
      dependencyStatus: {
        satisfied: false,
        missingBins: ['node'],
        missingEnvVars: [],
        missingReferences: [],
      },
    });

    expect(
      buildInstalledSkillSummary(
        [builtinSkill, coreLibrarySkill, missingDepsSkill],
        [coreLibrary, communityLibrary],
      ),
    ).toEqual({
      totalSkills: 3,
      libraryCount: 2,
      disabledSkills: 1, // coreLibrarySkill.enabled === false
      missingDependencySkills: 1,
    });
  });

  it('treats skills without enabled field as enabled (blacklist semantics)', () => {
    expect(buildInstalledSkillSummary([builtinSkill, projectSkill], []).disabledSkills).toBe(0);
  });
});

describe('filterSkillGroups', () => {
  const groups = buildInstalledSkillGroups(
    [builtinSkill, cloudSkill, projectSkill, coreLibrarySkill],
    [coreLibrary],
  );

  it('returns groups unchanged for empty query', () => {
    expect(filterSkillGroups(groups, '')).toBe(groups);
    expect(filterSkillGroups(groups, '   ')).toEqual(groups);
  });

  it('filters by name and removes empty groups', () => {
    const filtered = filterSkillGroups(groups, 'pdf');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].key).toBe('builtin');
    expect(filtered[0].skills.map((skill) => skill.name)).toEqual(['pdf']);
  });

  it('filters by description case-insensitively', () => {
    const filtered = filterSkillGroups(groups, 'RESEARCH DESC');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].key).toBe('project');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterSkillGroups(groups, 'nonexistent-skill-xyz')).toEqual([]);
  });
});
