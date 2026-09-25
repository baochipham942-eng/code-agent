import fs from 'fs/promises';
import path from 'path';
import { materializeOfficialSkillSection } from '../../security/skillOfficialSectionGuard';
import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../shared/contract/skillRegistry';
import type { InstalledPluginsFile, KnownMarketplacesConfig } from './types';
import { resolveInside } from './pathUtils';

export async function migrateInstalledPlugins(
  state: InstalledPluginsFile,
  knownMarketplaces: KnownMarketplacesConfig,
): Promise<InstalledPluginsFile> {
  let migrated: InstalledPluginsFile | undefined;
  const officialRegistryIsRegistered = Object.keys(knownMarketplaces)
    .some((name) => name.toLowerCase() === SKILL_REGISTRY_MARKETPLACE_ID);
  const newlyOfficialPluginSpecs: string[] = [];
  for (const [pluginSpec, record] of Object.entries(state)) {
    if (record.sourceTrust || record.marketplace.toLowerCase() !== SKILL_REGISTRY_MARKETPLACE_ID) continue;
    migrated ??= { ...state };
    const sourceTrust = officialRegistryIsRegistered ? 'local-marketplace' : 'official-registry';
    migrated[pluginSpec] = { ...record, sourceTrust };
    if (sourceTrust === 'official-registry') newlyOfficialPluginSpecs.push(pluginSpec);
  }
  const result = migrated ?? state;
  await backfillOfficialSkillSections(result, newlyOfficialPluginSpecs);
  return result;
}

async function backfillOfficialSkillSections(
  state: InstalledPluginsFile,
  pluginSpecs: string[],
): Promise<void> {
  for (const pluginSpec of pluginSpecs) {
    const record = state[pluginSpec];
    if (!record) continue;
    const skillRoot = record.pluginRoot || record.sourceMarketplacePath;
    if (record.sourceTrust !== 'official-registry' || !skillRoot) continue;
    for (const relPath of record.skillPaths || []) {
      try {
        const skillPath = path.join(resolveInside(skillRoot, relPath, 'Skill path'), 'SKILL.md');
        const content = await fs.readFile(skillPath, 'utf8');
        const materialized = materializeOfficialSkillSection(content);
        if (materialized !== content) await fs.writeFile(skillPath, materialized, 'utf8');
      } catch {
        // A missing or malformed legacy asset must not make the installed state unreadable.
      }
    }
  }
}
