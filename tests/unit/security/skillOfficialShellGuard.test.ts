import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardShellOfficialSkillWrites } from '../../../src/host/security/skillOfficialShellGuard';

const OFFICIAL_SKILL_SECTION_BEGIN = '<!-- NEO:OFFICIAL-SKILL:BEGIN -->';
const OFFICIAL_SKILL_SECTION_END = '<!-- NEO:OFFICIAL-SKILL:END -->';

describe('guardShellOfficialSkillWrites', () => {
  it('blocks shell writes to an existing protected SKILL.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-official-shell-'));
    const skillPath = path.join(root, 'SKILL.md');
    await fs.writeFile(skillPath, `${OFFICIAL_SKILL_SECTION_BEGIN}\nmanaged\n${OFFICIAL_SKILL_SECTION_END}\n`, 'utf8');

    const result = await guardShellOfficialSkillWrites('printf notes >> SKILL.md', root);

    expect(result).toMatchObject({
      allowed: false,
      code: 'OFFICIAL_SKILL_SECTION_PROTECTED',
    });
    expect(result.path).toBe(await fs.realpath(skillPath));
  });

  it('allows unmarked and new SKILL.md shell writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-official-shell-'));
    await fs.writeFile(path.join(root, 'SKILL.md'), '# local notes\n', 'utf8');

    await expect(guardShellOfficialSkillWrites('printf notes >> SKILL.md', root)).resolves.toEqual({ allowed: true });
    await expect(guardShellOfficialSkillWrites('printf notes > new/SKILL.md', root)).resolves.toEqual({ allowed: true });
  });

  it('returns a structured refusal when an existing SKILL.md cannot be read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-official-shell-'));
    const skillPath = path.join(root, 'SKILL.md');
    await fs.mkdir(skillPath);

    await expect(guardShellOfficialSkillWrites('printf notes >> SKILL.md', root)).resolves.toMatchObject({
      allowed: false,
      code: 'OFFICIAL_SKILL_SECTION_PROTECTED',
      path: await fs.realpath(skillPath),
    });
  });

  it('keeps the guard when SKILL.md is a symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-official-shell-'));
    const target = path.join(root, 'managed.md');
    await fs.writeFile(target, `${OFFICIAL_SKILL_SECTION_BEGIN}\nmanaged\n${OFFICIAL_SKILL_SECTION_END}\n`, 'utf8');
    await fs.symlink(target, path.join(root, 'SKILL.md'));

    const result = await guardShellOfficialSkillWrites('printf notes > SKILL.md', root);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('OFFICIAL_SKILL_SECTION_PROTECTED');
  });

  it('blocks unresolved variable and wildcard SKILL.md targets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-official-shell-'));

    await expect(guardShellOfficialSkillWrites('printf notes > $SKILL_ROOT/SKILL.md', root)).resolves.toMatchObject({
      allowed: false,
      code: 'OFFICIAL_SKILL_SECTION_PROTECTED',
      path: '${SKILL_ROOT}/SKILL.md',
    });
    await expect(guardShellOfficialSkillWrites('printf notes > */SKILL.md', root)).resolves.toMatchObject({
      allowed: false,
      code: 'OFFICIAL_SKILL_SECTION_PROTECTED',
      path: '*/SKILL.md',
    });
  });
});
