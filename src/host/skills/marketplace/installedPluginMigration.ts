import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../shared/contract/skillRegistry';
import type { InstalledPluginsFile } from './types';

export async function migrateInstalledPlugins(
  state: InstalledPluginsFile,
): Promise<InstalledPluginsFile> {
  let migrated: InstalledPluginsFile | undefined;
  for (const [pluginSpec, record] of Object.entries(state)) {
    if (record.sourceTrust || record.marketplace.toLowerCase() !== SKILL_REGISTRY_MARKETPLACE_ID) continue;
    migrated ??= { ...state };
    // Legacy records only retain an untrusted marketplace label and archive
    // metadata. They cannot prove that the signed registry install path was
    // used, so keep them non-official until the user reinstalls via that path.
    migrated[pluginSpec] = { ...record, sourceTrust: 'local-marketplace' };
  }
  return migrated ?? state;
}
