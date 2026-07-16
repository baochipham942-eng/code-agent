import { describe, expect, it } from 'vitest';
import {
  matchSkillRegistryDraftRecommendations,
} from '../../../../src/host/skills/marketplace/skillRegistryMatcher';
import type {
  SkillRegistryEntry,
  SkillRegistryListItem,
} from '../../../../src/shared/contract/skillRegistry';

const PIN = 'a'.repeat(40);
const HASH = '1'.repeat(64);

function entry(name: string, overrides: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry {
  return {
    name,
    displayName: name,
    description: `${name} description`,
    repository: `owner/${name}`,
    pinnedCommit: PIN,
    contentHash: HASH,
    skills: [`skills/${name}`],
    publisher: 'Agent Neo',
    reviewedAt: '2026-07-17',
    ...overrides,
  };
}

function item(
  name: string,
  overrides: Partial<SkillRegistryEntry> = {},
  installed = false,
): SkillRegistryListItem {
  return {
    entry: entry(name, overrides),
    installed,
    hasUpdate: false,
  };
}

describe('matchSkillRegistryDraftRecommendations', () => {
  it('uses word boundaries so art does not match cartography', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('build cartography tools', [
      item('art-skill', { keywords: ['art'] }),
    ]);

    expect(recommendations.map((rec) => rec.skillName)).toEqual([]);
  });

  it('matches keywords case-insensitively', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('Need a FIGMA export workflow', [
      item('figma-skill', { keywords: ['figma'] }),
    ]);

    expect(recommendations.map((rec) => rec.skillName)).toEqual(['figma-skill']);
    expect(recommendations.map((rec) => rec.action)).toEqual(['install']);
  });

  it('matches Chinese terms by containment', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('帮我整理会议纪要', [
      item('meeting-note', { keywords: ['会议纪要'] }),
    ]);

    expect(recommendations.map((rec) => rec.skillName)).toEqual(['meeting-note']);
  });

  it('filters already installed registry items', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('make a ppt deck', [
      item('ppt-skill', { keywords: ['ppt'] }, true),
    ]);

    expect(recommendations.map((rec) => rec.skillName)).toEqual([]);
  });

  it('filters skills already recommended in this session', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('make a ppt deck', [
      item('ppt-skill', { keywords: ['ppt'] }),
    ], {
      alreadyRecommendedSkillNames: new Set(['ppt-skill']),
    });

    expect(recommendations.map((rec) => rec.skillName)).toEqual([]);
  });

  it('sorts by hit count and caps to two recommendations', () => {
    const recommendations = matchSkillRegistryDraftRecommendations('figma ppt github.com export design', [
      item('gamma', { keywords: ['ppt'] }),
      item('alpha', { keywords: ['figma', 'export'], domains: ['github.com'] }),
      item('beta', { tags: ['design'], keywords: ['ppt'] }),
    ]);

    expect(recommendations.map((rec) => rec.skillName)).toEqual(['alpha', 'beta']);
    expect(recommendations.map((rec) => rec.libraryId)).toEqual([
      'alpha@official-registry',
      'beta@official-registry',
    ]);
  });
});
