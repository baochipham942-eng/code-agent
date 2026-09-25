import path from 'path';
import { getUserConfigDir, getProjectConfigDir } from '../../config/configPaths';
import type { PluginScope } from './types';

export function getSkillsDir(scope: PluginScope, projectPath?: string): string {
  if (scope === 'user') return path.join(getUserConfigDir(), 'skills');
  if (!projectPath) throw new Error('Project path required for project scope');
  return path.join(getProjectConfigDir(projectPath), 'skills');
}

export function resolveInside(baseDir: string, candidatePath: string, label = 'Command path'): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(baseDir, candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside plugin source: ${candidatePath}`);
  }
  return resolvedCandidate;
}
