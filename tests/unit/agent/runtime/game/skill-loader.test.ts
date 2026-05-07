import { describe, it, expect } from 'vitest';
import path from 'path';
import { promises as fsp } from 'fs';
import os from 'os';

import {
  extractSection,
  loadAllSkills,
  loadSkill,
} from '../../../../../src/main/agent/runtime/game/skill-loader';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../../tests/fixtures/skills');
const SAMPLE_DIR = path.join(FIXTURE_ROOT, 'sample');

describe('loadSkill', () => {
  it('parses frontmatter + body for the sample fixture', async () => {
    const m = await loadSkill(SAMPLE_DIR);
    expect(m.frontmatter.name).toBe('sample');
    expect(m.frontmatter.artifact_kind).toBe('game');
    expect(m.frontmatter.subtype).toBe('platformer');
    expect(Array.isArray(m.frontmatter.declared_verbs)).toBe(true);
    expect(m.frontmatter.declared_verbs?.[0]?.verb).toBe('defeat');
    expect(m.body).toContain('# Sample Skill');
    expect(m.path).toBe(path.join(SAMPLE_DIR, 'SKILL.md'));
  });

  it('throws when the SKILL.md is missing', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-loader-'));
    try {
      await expect(loadSkill(tmp)).rejects.toThrow(/Skill manifest not found/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when frontmatter is missing required field', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-loader-'));
    try {
      await fsp.writeFile(
        path.join(tmp, 'SKILL.md'),
        '---\nname: bad\n---\n\n# body\n',
      );
      await expect(loadSkill(tmp)).rejects.toThrow(/missing required frontmatter/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when there is no frontmatter at all', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-loader-'));
    try {
      await fsp.writeFile(path.join(tmp, 'SKILL.md'), '# no frontmatter here\n');
      await expect(loadSkill(tmp)).rejects.toThrow(/missing YAML frontmatter/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadAllSkills', () => {
  it('finds the sample skill and skips _template / non-skill subdirs', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-loader-all-'));
    try {
      // copy sample
      const sampleTarget = path.join(tmp, 'sample');
      await fsp.mkdir(sampleTarget);
      await fsp.copyFile(
        path.join(SAMPLE_DIR, 'SKILL.md'),
        path.join(sampleTarget, 'SKILL.md'),
      );
      // _template dir — should be skipped
      const tplTarget = path.join(tmp, '_template');
      await fsp.mkdir(tplTarget);
      await fsp.writeFile(
        path.join(tplTarget, 'SKILL.md'),
        '---\nname: x\ndescription: x\nartifact_kind: game\n---\nbody',
      );
      // a directory without SKILL.md — should be skipped silently
      await fsp.mkdir(path.join(tmp, 'helpers'));

      const all = await loadAllSkills(tmp);
      expect(all.map((m) => m.frontmatter.name).sort()).toEqual(['sample']);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('extractSection', () => {
  it('returns content of a top-level section', async () => {
    const m = await loadSkill(SAMPLE_DIR);
    const s = extractSection(m.body, 'Generation Contract');
    expect(s).toBeDefined();
    expect(s).toContain('step(\'jump\')');
    expect(s).toContain('Sub-section under contract'); // included because nested heading is deeper
  });

  it('returns content of a nested section', async () => {
    const m = await loadSkill(SAMPLE_DIR);
    const s = extractSection(m.body, 'Sub-section under contract');
    expect(s).toBeDefined();
    expect(s).toContain('intentionally nested');
  });

  it('returns undefined for missing section', async () => {
    const m = await loadSkill(SAMPLE_DIR);
    expect(extractSection(m.body, 'Nope Not Here')).toBeUndefined();
  });

  it('stops at next same-level heading', () => {
    const body = [
      '## A',
      'a-content',
      '## B',
      'b-content',
    ].join('\n');
    expect(extractSection(body, 'A')).toBe('a-content');
    expect(extractSection(body, 'B')).toBe('b-content');
  });
});
