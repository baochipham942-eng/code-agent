import fsSync from 'fs';
import path from 'path';
import type { InstalledPluginsFile } from './types';
import { getSkillsDir, resolveInside } from './pathUtils';

interface EnabledSkillDescriptor {
  dir: string;
  official: boolean;
}

/** Resolve enabled plugin Skills and retain whether the official registry owns them. */
export async function collectEnabledSkillDescriptors(): Promise<EnabledSkillDescriptor[]> {
  const { loadInstalledPlugins } = await import('./installService');
  const state: InstalledPluginsFile = await loadInstalledPlugins();
  const descriptors: EnabledSkillDescriptor[] = [];
  for (const record of Object.values(state)) {
    if (!record.isEnabled) continue;
    const official = record.sourceTrust === 'official-registry';
    const pluginRoot = record.pluginRoot || record.sourceMarketplacePath;
    if (pluginRoot && record.skillPaths?.length) {
      for (const relPath of record.skillPaths) {
        const dir = resolveInside(pluginRoot, relPath, 'Skill path');
        if (fsSync.existsSync(dir)) descriptors.push({ dir, official });
      }
      continue;
    }
    const skillsDir = getSkillsDir(record.scope, record.projectPath);
    for (const skillName of record.skills || []) {
      const dir = path.join(skillsDir, skillName);
      if (fsSync.existsSync(dir)) descriptors.push({ dir, official });
    }
  }
  return descriptors;
}
