import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectRepositoryLayout } from '../../../../src/host/services/skills/skillRepositoryLayout';

describe('detectRepositoryLayout', () => {
  let repositoryRoot: string;

  beforeEach(async () => {
    repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-layout-'));
  });

  afterEach(async () => {
    await fs.rm(repositoryRoot, { recursive: true, force: true });
  });

  async function writeSkill(relativeDirectory: string): Promise<void> {
    const skillDirectory = path.join(repositoryRoot, relativeDirectory);
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: sample\ndescription: Sample skill\n---\n\nUse it.\n',
      'utf-8'
    );
  }

  it('detects a root SKILL.md as a single-skill package', async () => {
    await writeSkill('.');

    await expect(detectRepositoryLayout(repositoryRoot)).resolves.toEqual({
      layout: 'single-skill',
      skillsPath: '.',
    });
  });

  it('detects direct skill children under skills/', async () => {
    await writeSkill('skills/sample');

    await expect(detectRepositoryLayout(repositoryRoot)).resolves.toEqual({
      layout: 'library',
      skillsPath: 'skills',
    });
  });

  it('detects direct skill children at repository root', async () => {
    await writeSkill('sample');

    await expect(detectRepositoryLayout(repositoryRoot)).resolves.toEqual({
      layout: 'library',
      skillsPath: '.',
    });
  });

  it('rejects repositories without any discoverable SKILL.md', async () => {
    await fs.mkdir(path.join(repositoryRoot, 'nested', 'sample'), { recursive: true });
    await fs.writeFile(
      path.join(repositoryRoot, 'nested', 'sample', 'SKILL.md'),
      'not scanned at this depth',
      'utf-8'
    );

    await expect(detectRepositoryLayout(repositoryRoot)).rejects.toThrow(
      'No SKILL.md found in repository'
    );
  });
});
