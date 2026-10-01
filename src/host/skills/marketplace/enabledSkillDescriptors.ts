import fsSync from 'fs';
import path from 'path';
import type { InstalledPluginsFile } from './types';
import { getSkillsDir, resolveInside } from './pathUtils';

interface EnabledSkillDescriptor {
  dir: string;
  official: boolean;
}

/** Resolve enabled plugin Skills and retain whether the official registry owns them. */
export async function collectEnabledSkillDescriptors(
  excludePluginSpecs?: ReadonlySet<string>,
): Promise<EnabledSkillDescriptor[]> {
  const { loadInstalledPlugins } = await import('./installService');
  const state: InstalledPluginsFile = await loadInstalledPlugins();
  const descriptors: EnabledSkillDescriptor[] = [];
  for (const [pluginSpec, record] of Object.entries(state)) {
    // 重扫内存阻断集：禁用落盘失败时也不能装载（ai-review R2 Nit1）
    if (excludePluginSpecs?.has(pluginSpec)) continue;
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
