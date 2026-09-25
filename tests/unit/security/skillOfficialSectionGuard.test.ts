import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_SKILL_SECTION_BEGIN,
  OFFICIAL_SKILL_SECTION_END,
  guardSkillOfficialSections,
} from '../../../src/host/security/skillOfficialSectionGuard';

const officialBlock = [
  OFFICIAL_SKILL_SECTION_BEGIN,
  '# Shipped instructions',
  'Do not rewrite this section.',
  OFFICIAL_SKILL_SECTION_END,
].join('\n');

describe('guardSkillOfficialSections', () => {
  it('allows notes after an intact official section', () => {
    const original = `${officialBlock}\n`;
    const next = `${officialBlock}\n\n## Durable notes\nKeep this current.\n`;

    expect(guardSkillOfficialSections('/tmp/SKILL.md', original, next)).toEqual({ allowed: true });
  });

  it('rejects edits inside an official section', () => {
    const original = `${officialBlock}\n`;
    const next = `${officialBlock.replace('Do not rewrite', 'Rewrite')}\n`;

    expect(guardSkillOfficialSections('/tmp/SKILL.md', original, next)).toMatchObject({
      allowed: false,
      code: 'OFFICIAL_SKILL_SECTION_PROTECTED',
    });
  });

  it('rejects missing, nested, or unmatched markers', () => {
    const malformed = `${OFFICIAL_SKILL_SECTION_BEGIN}\ntext\n`;
    expect(guardSkillOfficialSections('/tmp/SKILL.md', malformed, malformed)).toMatchObject({ allowed: false });
    expect(guardSkillOfficialSections('/tmp/SKILL.md', `${officialBlock}\n`, `${OFFICIAL_SKILL_SECTION_BEGIN}\n${officialBlock}\n${OFFICIAL_SKILL_SECTION_END}`)).toMatchObject({ allowed: false });
  });

  it('does not affect ordinary files or unmarked skills', () => {
    expect(guardSkillOfficialSections('/tmp/notes.md', 'before', 'after')).toEqual({ allowed: true });
    expect(guardSkillOfficialSections('/tmp/SKILL.md', 'before', 'after')).toEqual({ allowed: true });
  });
});
