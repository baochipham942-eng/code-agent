// ============================================================================
// Marketplace IPC Handlers - marketplace:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import {
  listMarketplaces,
  addMarketplace,
  removeMarketplace,
  refreshMarketplace,
  getMarketplaceInfo,
  listAllPlugins,
  searchPlugins,
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  enablePlugin,
  disablePlugin,
} from '../skills/marketplace';
import type {
  MarketplaceInfo,
  MarketplacePluginEntry,
  InstalledPlugin,
  MarketplaceResult,
  PluginInstallResult,
} from '../skills/marketplace';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MarketplaceIPC');

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

function successResult<T>(data: T): MarketplaceResult<T> {
  return { success: true, data };
}

function errorResult<T>(error: unknown): MarketplaceResult<T> {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * Register Marketplace IPC handlers
 */
export function registerMarketplaceHandlers(ipcMain: IpcMain): void {
  // List all known marketplaces
  ipcMain.handle(IPC_CHANNELS.MARKETPLACE_LIST, async (): Promise<MarketplaceResult<MarketplaceInfo[]>> => {
    try {
      const config = await listMarketplaces();
      const results: MarketplaceInfo[] = [];

      for (const [name, entry] of Object.entries(config)) {
        try {
          const info = await getMarketplaceInfo(name);
          results.push({
            name,
            description: info.manifest.description,
            source: entry.source,
            installLocation: entry.installLocation,
            lastUpdated: entry.lastUpdated,
            pluginCount: info.manifest.plugins.length,
            autoUpdate: entry.autoUpdate,
          });
        } catch {
          // Include basic info even if manifest read fails
          results.push({
            name,
            source: entry.source,
            installLocation: entry.installLocation,
            lastUpdated: entry.lastUpdated,
            pluginCount: 0,
            autoUpdate: entry.autoUpdate,
          });
        }
      }

      return successResult(results);
    } catch (error) {
      logger.error('Failed to list marketplaces', { error });
      return errorResult(error);
    }
  });

  // Add a new marketplace
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_ADD,
    async (_, source: string): Promise<MarketplaceResult<MarketplaceInfo>> => {
      try {
        const result = await addMarketplace(source);
        const info = await getMarketplaceInfo(result.name);
        const config = await listMarketplaces();
        const entry = config[result.name];

        return successResult({
          name: result.name,
          description: info.manifest.description,
          source: entry!.source,
          installLocation: entry!.installLocation,
          lastUpdated: entry!.lastUpdated,
          pluginCount: info.manifest.plugins.length,
          autoUpdate: entry!.autoUpdate,
        });
      } catch (error) {
        logger.error('Failed to add marketplace', { source, error });
        return errorResult(error);
      }
    }
  );

  // Remove a marketplace
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_REMOVE,
    async (_, name: string): Promise<MarketplaceResult<void>> => {
      try {
        await removeMarketplace(name);
        return successResult(undefined);
      } catch (error) {
        logger.error('Failed to remove marketplace', { name, error });
        return errorResult(error);
      }
    }
  );

  // Refresh a marketplace
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_REFRESH,
    async (_, name?: string): Promise<MarketplaceResult<void>> => {
      try {
        if (name) {
          await refreshMarketplace(name);
        } else {
          // Refresh all marketplaces
          const config = await listMarketplaces();
          for (const marketplaceName of Object.keys(config)) {
            try {
              await refreshMarketplace(marketplaceName);
            } catch (err) {
              logger.warn('Failed to refresh marketplace', { name: marketplaceName, error: err });
            }
          }
        }
        return successResult(undefined);
      } catch (error) {
        logger.error('Failed to refresh marketplace', { name, error });
        return errorResult(error);
      }
    }
  );

  // Get marketplace info
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_INFO,
    async (_, name: string): Promise<MarketplaceResult<MarketplaceInfo>> => {
      try {
        const info = await getMarketplaceInfo(name);
        const config = await listMarketplaces();
        const entry = config[name];

        return successResult({
          name,
          description: info.manifest.description,
          source: entry!.source,
          installLocation: entry!.installLocation,
          lastUpdated: entry!.lastUpdated,
          pluginCount: info.manifest.plugins.length,
          autoUpdate: entry!.autoUpdate,
        });
      } catch (error) {
        logger.error('Failed to get marketplace info', { name, error });
        return errorResult(error);
      }
    }
  );

  // List all plugins from all marketplaces
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS,
    async (_, marketplaceId?: string): Promise<MarketplaceResult<MarketplacePluginEntry[]>> => {
      try {
        const allPlugins = await listAllPlugins();
        const installed = await listInstalledPlugins();

        let plugins = allPlugins;
        if (marketplaceId) {
          plugins = allPlugins.filter(p => p.marketplace === marketplaceId);
        }

        const results: MarketplacePluginEntry[] = plugins.map(({ plugin, marketplace }) => {
          const installedRecord = installed[`${plugin.name}@${marketplace}`];
          return {
            name: plugin.name,
            description: plugin.description,
            marketplace,
            source: plugin.source,
            skills: plugin.skills,
            commands: plugin.commands,
            tags: plugin.tags,
            version: plugin.version,
            author: plugin.author,
            isInstalled: !!installedRecord,
            isEnabled: installedRecord?.isEnabled,
          };
        });

        return successResult(results);
      } catch (error) {
        logger.error('Failed to list plugins', { error });
        return errorResult(error);
      }
    }
  );

  // Search plugins
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_SEARCH_PLUGINS,
    async (_, query: string): Promise<MarketplaceResult<MarketplacePluginEntry[]>> => {
      try {
        const plugins = await searchPlugins(query);
        const installed = await listInstalledPlugins();

        const results: MarketplacePluginEntry[] = plugins.map(({ plugin, marketplace }) => {
          const installedRecord = installed[`${plugin.name}@${marketplace}`];
          return {
            name: plugin.name,
            description: plugin.description,
            marketplace,
            source: plugin.source,
            skills: plugin.skills,
            commands: plugin.commands,
            tags: plugin.tags,
            version: plugin.version,
            author: plugin.author,
            isInstalled: !!installedRecord,
            isEnabled: installedRecord?.isEnabled,
          };
        });

        return successResult(results);
      } catch (error) {
        logger.error('Failed to search plugins', { query, error });
        return errorResult(error);
      }
    }
  );

  // Install a plugin
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN,
    async (_, pluginSpec: string, options?: { scope?: 'user' | 'project'; projectPath?: string }): Promise<PluginInstallResult> => {
      try {
        const result = await installPlugin(pluginSpec, options);
        const installed = await listInstalledPlugins();
        const record = installed[pluginSpec];

        return {
          success: true,
          plugin: record ? {
            name: record.plugin,
            marketplace: record.marketplace,
            scope: record.scope,
            isEnabled: record.isEnabled,
            projectPath: record.projectPath,
            installedAt: record.installedAt,
            pluginRoot: record.pluginRoot,
            skills: record.skills,
            commands: record.commands,
          } : undefined,
          installedSkills: result.installedSkills,
          installedCommands: result.installedCommands,
        };
      } catch (error) {
        logger.error('Failed to install plugin', { pluginSpec, error });
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  // Uninstall a plugin
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_UNINSTALL_PLUGIN,
    async (_, pluginSpec: string, scope?: 'user' | 'project'): Promise<MarketplaceResult<void>> => {
      try {
        await uninstallPlugin(pluginSpec, { scope });
        return successResult(undefined);
      } catch (error) {
        logger.error('Failed to uninstall plugin', { pluginSpec, error });
        return errorResult(error);
      }
    }
  );

  // List installed plugins
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED,
    async (_, scope?: 'user' | 'project' | 'all'): Promise<MarketplaceResult<InstalledPlugin[]>> => {
      try {
        const installed = await listInstalledPlugins();
        const results: InstalledPlugin[] = [];

        for (const [key, record] of Object.entries(installed)) {
          // Filter by scope if specified
          if (scope && scope !== 'all' && record.scope !== scope) {
            continue;
          }

          results.push({
            name: record.plugin,
            marketplace: record.marketplace,
            scope: record.scope,
            isEnabled: record.isEnabled,
            projectPath: record.projectPath,
            installedAt: record.installedAt,
            pluginRoot: record.pluginRoot,
            skills: record.skills,
            commands: record.commands,
          });
        }

        return successResult(results);
      } catch (error) {
        logger.error('Failed to list installed plugins', { error });
        return errorResult(error);
      }
    }
  );

  // Enable a plugin
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_ENABLE_PLUGIN,
    async (_, pluginSpec: string): Promise<MarketplaceResult<void>> => {
      try {
        await enablePlugin(pluginSpec);
        return successResult(undefined);
      } catch (error) {
        logger.error('Failed to enable plugin', { pluginSpec, error });
        return errorResult(error);
      }
    }
  );

  // Disable a plugin
  ipcMain.handle(
    IPC_CHANNELS.MARKETPLACE_DISABLE_PLUGIN,
    async (_, pluginSpec: string): Promise<MarketplaceResult<void>> => {
      try {
        await disablePlugin(pluginSpec);
        return successResult(undefined);
      } catch (error) {
        logger.error('Failed to disable plugin', { pluginSpec, error });
        return errorResult(error);
      }
    }
  );

  logger.info('Marketplace IPC handlers registered');
}
