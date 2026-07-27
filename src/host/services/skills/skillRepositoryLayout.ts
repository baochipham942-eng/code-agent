import * as fs from 'fs/promises';
import * as path from 'path';
import { hasSkillMd } from './skillParser';

export interface RepositoryLayout {
  layout: 'single-skill' | 'library';
  skillsPath: '.' | 'skills';
}

async function hasDirectChildSkill(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        await hasSkillMd(path.join(directory, entry.name))
      ) {
        return true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return false;
}

/**
 * Detect the Agent Skills package layout without relying on provider-specific
 * directory conventions.
 */
export async function detectRepositoryLayout(
  repositoryRoot: string
): Promise<RepositoryLayout> {
  if (await hasSkillMd(repositoryRoot)) {
    return {
      layout: 'single-skill',
      skillsPath: '.',
    };
  }

  if (await hasDirectChildSkill(path.join(repositoryRoot, 'skills'))) {
    return {
      layout: 'library',
      skillsPath: 'skills',
    };
  }

  if (await hasDirectChildSkill(repositoryRoot)) {
    return {
      layout: 'library',
      skillsPath: '.',
    };
  }

  throw new Error('No SKILL.md found in repository');
}
