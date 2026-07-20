import { afterEach, describe, it, expect, vi } from 'vitest';
import path from 'path';
import { promises as fsp } from 'fs';
import os from 'os';
import yaml from 'js-yaml';

import {
  extractSection,
  loadAllSkills,
  loadSkill,
} from '../../../../../src/host/agent/runtime/game/skill-loader';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../../tests/fixtures/skills');
const SAMPLE_DIR = path.join(FIXTURE_ROOT, 'sample');

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

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
    const originalError = new Error('manifest read failed');
    vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(originalError);
    try {
      const error = await captureError(loadSkill(tmp));
      expect(error.message).toMatch(/Skill manifest not found/);
      expect(error.cause).toBe(originalError);
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

  it('preserves the YAML parser error as the cause', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-loader-'));
    const originalError = new Error('yaml parser failed');
    vi.spyOn(yaml, 'load').mockImplementationOnce(() => {
      throw originalError;
    });
    try {
      await fsp.writeFile(
        path.join(tmp, 'SKILL.md'),
        '---\nname: bad\ndescription: bad\nartifact_kind: game\n---\n',
      );
      const error = await captureError(loadSkill(tmp));
      expect(error.message).toContain('Invalid YAML frontmatter');
      expect(error.cause).toBe(originalError);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadAllSkills', () => {
  it('preserves the directory read error as the cause', async () => {
    const originalError = new Error('skills root read failed');
    vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(originalError);

    const error = await captureError(loadAllSkills('/missing-skills-root'));

    expect(error.message).toContain('Skills root not readable');
    expect(error.cause).toBe(originalError);
  });

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
