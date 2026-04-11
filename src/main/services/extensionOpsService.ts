// ============================================================================
// ExtensionOpsService - Unified facade for plugin & marketplace management
// ============================================================================
// Provides a single API surface over two separate extension runtimes:
//   1. JS plugins  (pluginRegistry)   — full lifecycle, tools + hooks, SQLite
//   2. Marketplace (installService)   — install/uninstall/enable/disable, stateless
// ============================================================================

import type {
  ExtensionInfo,
  ExtensionType,
  ExtensionStatus,
  ExtensionSource,
} from '../../shared/types/extension';
import type { ValidationResult } from '../plugins/pluginValidator';
import { createLogger } from './infra/logger';

const logger = createLogger('ExtensionOpsService');

// ----------------------------------------------------------------------------
// ExtensionOpsService
// ----------------------------------------------------------------------------

class ExtensionOpsService {
  /** Lazy cache: extension id → type. Built on first list() call. */
  private typeCache: Map<string, ExtensionType> | null = null;

  // --------------------------------------------------------------------------
  // List
  // --------------------------------------------------------------------------

  /**
   * List all extensions from both backends, merged into a unified shape.
   */
  async list(): Promise<ExtensionInfo[]> {
    const results: ExtensionInfo[] = [];
    const seen = new Set<string>();

    // 1. JS plugins from pluginRegistry
    try {
      const { getPluginRegistry } = await import('../plugins/pluginRegistry');
      const registry = getPluginRegistry();
      for (const plugin of registry.getPlugins()) {
        const info: ExtensionInfo = {
          id: plugin.manifest.id,
          name: plugin.manifest.name || plugin.manifest.id,
          type: 'plugin',
          status: mapPluginState(plugin.state),
          source: 'local',
          version: plugin.manifest.version,
          description: plugin.manifest.description,
          error: plugin.error,
        };
        results.push(info);
        seen.add(info.id);
      }
    } catch (err) {
      logger.warn('Failed to list JS plugins', { error: err });
    }

    // 2. Marketplace skills from installService
    try {
      const { listInstalledPlugins } = await import(
        '../skills/marketplace/installService'
      );
      const installed = await listInstalledPlugins();
      for (const [spec, record] of Object.entries(installed)) {
        // A marketplace plugin can provide skills AND commands.
        // Represent the whole install as type 'skill' (its primary purpose).
        if (seen.has(spec)) continue;

        const info: ExtensionInfo = {
          id: spec,
          name: record.plugin,
          type: 'skill',
          status: record.isEnabled ? 'active' : 'disabled',
          source: 'marketplace',
          marketplace: record.marketplace,
        };
        results.push(info);
        seen.add(info.id);
      }
    } catch (err) {
      logger.warn('Failed to list marketplace plugins', { error: err });
    }

    // 3. MCP servers from mcpClient
    try {
      const { getMCPClient } = await import('../mcp/mcpClient');
      const status = getMCPClient().getStatus();
      for (const name of [...status.connectedServers, ...status.inProcessServers]) {
        const mcpId = `mcp:${name}`;
        if (seen.has(mcpId)) continue;
        results.push({
          id: mcpId,
          name,
          type: 'command',
          status: 'active',
          source: 'local',
        });
        seen.add(mcpId);
      }
    } catch {
      // MCP client not available
    }

    // Rebuild type cache
    this.typeCache = new Map();
    for (const ext of results) {
      this.typeCache.set(ext.id, ext.type);
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Get
  // --------------------------------------------------------------------------

  async get(id: string): Promise<ExtensionInfo | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }

  // --------------------------------------------------------------------------
  // Install (marketplace only)
  // --------------------------------------------------------------------------

  async install(spec: string): Promise<void> {
    const { installPlugin } = await import(
      '../skills/marketplace/installService'
    );
    await installPlugin(spec);
    this.typeCache = null; // invalidate
  }

  // --------------------------------------------------------------------------
  // Uninstall
  // --------------------------------------------------------------------------

  async uninstall(id: string): Promise<void> {
    const type = await this.resolveType(id);

    if (type === 'plugin') {
      throw new Error(
        `JS plugin '${id}' cannot be uninstalled via this service. Remove the plugin directory manually.`
      );
    }

    const { uninstallPlugin } = await import(
      '../skills/marketplace/installService'
    );
    await uninstallPlugin(id);
    this.typeCache = null;
  }

  // --------------------------------------------------------------------------
  // Enable
  // --------------------------------------------------------------------------

  async enable(id: string): Promise<void> {
    const type = await this.resolveType(id);

    if (type === 'plugin') {
      const { getPluginRegistry } = await import('../plugins/pluginRegistry');
      const ok = await getPluginRegistry().activatePlugin(id);
      if (!ok) throw new Error(`Failed to activate JS plugin '${id}'`);
      return;
    }

    // marketplace skill
    const { enablePlugin } = await import(
      '../skills/marketplace/installService'
    );
    await enablePlugin(id);
  }

  // --------------------------------------------------------------------------
  // Disable
  // --------------------------------------------------------------------------

  async disable(id: string): Promise<void> {
    const type = await this.resolveType(id);

    if (type === 'plugin') {
      const { getPluginRegistry } = await import('../plugins/pluginRegistry');
      const ok = await getPluginRegistry().deactivatePlugin(id);
      if (!ok) throw new Error(`Failed to deactivate JS plugin '${id}'`);
      return;
    }

    const { disablePlugin } = await import(
      '../skills/marketplace/installService'
    );
    await disablePlugin(id);
  }

  // --------------------------------------------------------------------------
  // Reload
  // --------------------------------------------------------------------------

  /**
   * Reload a single extension (by id) or all extensions (if id omitted).
   */
  async reload(id?: string): Promise<void> {
    if (id) {
      const type = await this.resolveType(id);

      if (type === 'plugin') {
        const { getPluginRegistry } = await import('../plugins/pluginRegistry');
        const ok = await getPluginRegistry().reloadPlugin(id);
        if (!ok) throw new Error(`Failed to reload JS plugin '${id}'`);
        return;
      }

      // Marketplace skills don't have a per-plugin reload; reload discovery.
      const { getSkillDiscoveryService } = await import(
        './skills/skillDiscoveryService'
      );
      const svc = getSkillDiscoveryService();
      await svc.reload();
      return;
    }

    // Reload everything
    try {
      const { getSkillDiscoveryService } = await import(
        './skills/skillDiscoveryService'
      );
      await getSkillDiscoveryService().reload();
    } catch (err) {
      logger.warn('Failed to reload skill discovery', { error: err });
    }

    // Reload JS plugins
    try {
      const { getPluginRegistry } = await import('../plugins/pluginRegistry');
      const registry = getPluginRegistry();
      for (const plugin of registry.getPlugins()) {
        await registry.reloadPlugin(plugin.manifest.id).catch((e: unknown) => {
          logger.warn(`Failed to reload plugin ${plugin.manifest.id}`, { error: e });
        });
      }
    } catch (err) {
      logger.warn('Failed to reload JS plugins', { error: err });
    }

    this.typeCache = null;
  }

  // --------------------------------------------------------------------------
  // Validate (JS plugins only)
  // --------------------------------------------------------------------------

  async validate(id: string): Promise<ValidationResult> {
    const { getPluginRegistry } = await import('../plugins/pluginRegistry');
    const plugin = getPluginRegistry().getPlugin(id);

    if (!plugin) {
      return {
        valid: false,
        errors: [{ field: 'id', message: `Extension '${id}' not found or not a JS plugin` }],
        warnings: [],
      };
    }

    const { validatePlugin } = await import('../plugins/pluginValidator');
    return validatePlugin(plugin.rootPath, plugin.manifest);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve the type of an extension by id, using the lazy cache.
   */
  private async resolveType(id: string): Promise<ExtensionType> {
    if (!this.typeCache) {
      await this.list(); // populates cache
    }
    const type = this.typeCache?.get(id);
    if (!type) {
      throw new Error(`Extension '${id}' not found`);
    }
    return type;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function mapPluginState(
  state: string
): ExtensionStatus {
  switch (state) {
    case 'active':
      return 'active';
    case 'inactive':
    case 'activating':
      return 'inactive';
    case 'error':
      return 'error';
    case 'disabled':
      return 'disabled';
    default:
      return 'inactive';
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: ExtensionOpsService | null = null;

export function getExtensionOpsService(): ExtensionOpsService {
  if (!instance) {
    instance = new ExtensionOpsService();
  }
  return instance;
}

export { ExtensionOpsService };
