import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/security/role-pack-pin.mjs');

function baseDraft() {
  return {
    roleId: '岚析',
    agentMd: `---\nname: 岚析\ndescription: 增长分析师\nskills: [seo-audit]\n---\n\n分诊线：增长诊断找我。`,
    visual: {
      icon: 'TrendingUp', category: 'data-analysis', displayName: '岚析', profession: '增长分析师',
      tags: ['SEO', '留存', '渠道'], quickPrompts: ['诊断这个网站的增长问题'],
    },
    skills: ['seo-audit'],
    packVersion: '1.0.0',
    publisher: 'Agent Neo',
    reviewedAt: '2026-07-23',
  };
}

function run(draft: object, registryEntries = [{ name: 'seo-audit' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'role-pack-pin-test-'));
  const draftFile = join(dir, 'draft.json');
  const registryFile = join(dir, 'skill-registry.json');
  const out = join(dir, 'entry.json');
  writeFileSync(draftFile, JSON.stringify(draft));
  writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, entries: registryEntries }));
  try {
    execFileSync('node', [SCRIPT, '--draft', draftFile, '--skill-registry', registryFile, '--out', out], {
      encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, stderr: '', entry: JSON.parse(readFileSync(out, 'utf8')) };
  } catch (error) {
    const failed = error as { status: number; stderr: Buffer };
    return { code: failed.status, stderr: failed.stderr.toString(), entry: null };
  }
}

describe('role-pack-pin', () => {
  it('writes a RolePackEntry for a compliant draft', () => {
    const result = run(baseDraft());
    expect(result.code).toBe(0);
    expect(result.entry).toMatchObject({ roleId: '岚析', skills: [{ registryName: 'seo-audit' }], packVersion: '1.0.0' });
  });

  it.each([
    ['unparsable frontmatter', (draft: ReturnType<typeof baseDraft>) => { draft.agentMd = '没有 frontmatter'; }, 'agentMd frontmatter 无法解析'],
    ['unknown registry skill', (draft: ReturnType<typeof baseDraft>) => { draft.skills = ['missing-skill']; draft.agentMd = draft.agentMd.replace('seo-audit', 'missing-skill'); }, 'registry skill(s) not found: missing-skill'],
    ['builtin role collision', (draft: ReturnType<typeof baseDraft>) => { draft.roleId = '牧之'; draft.agentMd = draft.agentMd.replaceAll('岚析', '牧之'); }, 'conflicts with a builtin role'],
    ['missing visual field', (draft: ReturnType<typeof baseDraft>) => { delete (draft.visual as Partial<typeof draft.visual>).profession; }, 'visual.profession is required'],
    ['invalid category', (draft: ReturnType<typeof baseDraft>) => { draft.visual.category = 'invented-category'; }, 'is not a valid SkillCategory'],
    ['frontmatter name mismatch', (draft: ReturnType<typeof baseDraft>) => { draft.agentMd = draft.agentMd.replace('name: 岚析', 'name: 别名'); }, '与 roleId "岚析" 不一致'],
    ['empty pack version', (draft: ReturnType<typeof baseDraft>) => { draft.packVersion = ''; }, 'packVersion must be non-empty'],
  ])('fails closed for %s', (_name, mutate, expectedError) => {
    const draft = baseDraft();
    mutate(draft);
    const result = run(draft);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expectedError);
  });
});
