import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalSkillLibrary } from '../../../src/shared/contract/skillRepository';
import {
  buildSkillLibraryManagementRows,
  buildSkillLibraryManagementSummary,
  resolveSelectedSkillLibraryId,
} from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';

const baseTime = new Date('2026-05-15T08:00:00.000Z').getTime();

const coreLibrary = {
  repoId: 'core',
  repoName: 'Core Skills',
  localPath: '/skills/core',
  downloadedAt: baseTime - 10_000,
  lastUpdated: baseTime - 2 * 60 * 60 * 1000,
  version: 'abc123',
  skills: [
    {
      name: 'docx',
      description: 'Handle Word documents',
      libraryId: 'core',
      localPath: '/skills/core/docx',
      enabled: true,
    },
    {
      name: 'ppt',
      description: 'Create decks',
      libraryId: 'core',
      localPath: '/skills/core/ppt',
      enabled: false,
      dependencyStatus: {
        satisfied: false,
        missingBins: ['node'],
      },
    },
  ],
} satisfies LocalSkillLibrary;

const communityLibrary = {
  repoId: 'community',
  repoName: 'Community Skills',
  localPath: '/skills/community',
  downloadedAt: baseTime - 10_000,
  lastUpdated: baseTime - 5 * 60 * 1000,
  skills: [
    {
      name: 'jira',
      description: 'Work with Jira',
      libraryId: 'community',
      localPath: '/skills/community/jira',
      enabled: true,
      dependencyStatus: {
        satisfied: true,
      },
    },
  ],
} satisfies LocalSkillLibrary;

afterEach(() => {
  vi.useRealTimers();
});

describe('SkillsSettings management helpers', () => {
  it('keeps a valid selected library and falls back to the first library', () => {
    expect(resolveSelectedSkillLibraryId([coreLibrary, communityLibrary], 'community')).toBe('community');
    expect(resolveSelectedSkillLibraryId([coreLibrary, communityLibrary], 'missing')).toBe('core');
    expect(resolveSelectedSkillLibraryId([], 'missing')).toBeNull();
  });

  it('builds summary counts across libraries', () => {
    expect(buildSkillLibraryManagementSummary([coreLibrary, communityLibrary])).toEqual({
      libraryCount: 2,
      totalSkills: 3,
      enabledSkills: 2,
      disabledSkills: 1,
      missingDependencySkills: 1,
    });
  });

  it('builds management rows with selected state and dependency health', () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    const rows = buildSkillLibraryManagementRows({
      libraries: [coreLibrary, communityLibrary],
      selectedRepoId: 'community',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      repoId: 'core',
      selected: false,
      totalSkills: 2,
      enabledSkills: 1,
      disabledSkills: 1,
      missingDependencySkills: 1,
      lastUpdatedLabel: '2 小时前',
    });
    expect(rows[1]).toMatchObject({
      repoId: 'community',
      selected: true,
      totalSkills: 1,
      enabledSkills: 1,
      disabledSkills: 0,
      missingDependencySkills: 0,
      lastUpdatedLabel: '5 分钟前',
    });
  });
});
