import { describe, expect, it } from 'vitest';
import {
  AUTO_DOWNLOAD_REPOS,
  DEFAULT_ENABLED_SKILLS,
  RECOMMENDED_AUTO_DOWNLOAD_REPOS,
  RECOMMENDED_SKILL_AUTO_DOWNLOAD_ENV,
  getDefaultAutoDownloadRepos,
  getDefaultEnabledSkills,
  isRecommendedSkillAutoDownloadAllowed,
} from '../../../../src/main/services/skills/skillRepositories';

describe('skill repository trust defaults', () => {
  it('does not auto-download remote recommended repositories by default', () => {
    expect(AUTO_DOWNLOAD_REPOS).toEqual([]);
    expect(getDefaultAutoDownloadRepos({})).toEqual([]);
    expect(isRecommendedSkillAutoDownloadAllowed({})).toBe(false);
  });

  it('allows recommended repository preloading only with explicit opt-in', () => {
    const env = { [RECOMMENDED_SKILL_AUTO_DOWNLOAD_ENV]: '1' };

    expect(isRecommendedSkillAutoDownloadAllowed(env)).toBe(true);
    expect(getDefaultAutoDownloadRepos(env)).toEqual(RECOMMENDED_AUTO_DOWNLOAD_REPOS);
  });

  it('does not enable remote repository skills by default', () => {
    expect(getDefaultEnabledSkills('anthropic-skills')).toEqual([]);
    expect(getDefaultEnabledSkills('superpowers')).toEqual([]);
    expect(DEFAULT_ENABLED_SKILLS.builtin).toEqual(expect.arrayContaining(['data-cleaning', 'xlsx']));
  });
});
