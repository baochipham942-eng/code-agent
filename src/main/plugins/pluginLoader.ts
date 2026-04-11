// ============================================================================
// Plugin Loader - Load plugins from filesystem
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { app } from '../platform';
import type {
  PluginManifest,
  PluginEntry,
  LoadedPlugin,
  PluginLoadResult,
} from './types';
import {
  validatePlugin,
  formatValidationResult,
} from './pluginValidator';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const PLUGIN_MANIFEST_FILES = ['plugin.json', 'package.json'];
const PLUGINS_DIR_NAME = 'plugins';

// ----------------------------------------------------------------------------
// Plugin Loader
// ----------------------------------------------------------------------------

/**
 * Get the plugins directory path
 */
export function getPluginsDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, PLUGINS_DIR_NAME);
}

/**
 * Ensure plugins directory exists
 */
export async function ensurePluginsDir(): Promise<void> {
  const pluginsDir = getPluginsDir();
  try {
    await fs.access(pluginsDir);
  } catch {
    await fs.mkdir(pluginsDir, { recursive: true });
  }
}

/**
 * Read and parse plugin manifest
 */
async function readManifest(pluginDir: string): Promise<PluginManifest | null> {
  for (const filename of PLUGIN_MANIFEST_FILES) {
    const manifestPath = path.join(pluginDir, filename);
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      // Validate required fields
      if (!manifest.id && manifest.name) {
        manifest.id = manifest.name;
      }
      if (!manifest.id || !manifest.version) {
        console.warn(`Invalid manifest in ${pluginDir}: missing id or version`);
        return null;
      }

      // Default main entry
      if (!manifest.main) {
        manifest.main = 'index.js';
      }

      return manifest as PluginManifest;
    } catch {
      // Try next manifest file
      continue;
    }
  }

  return null;
}

/**
 * Load a single plugin from a directory
 */
export async function loadPlugin(pluginDir: string): Promise<PluginLoadResult> {
  try {
    // Read manifest
    const manifest = await readManifest(pluginDir);
    if (!manifest) {
      return {
        success: false,
        error: `No valid manifest found in ${pluginDir}`,
      };
    }

    // Structured validation
    try {
      const validation = await validatePlugin(pluginDir, manifest);
      if (!validation.valid) {
        const details = formatValidationResult(validation);
        return {
          success: false,
          error: `Plugin validation failed in ${pluginDir}:\n${details}`,
        };
      }
      // Log warnings even if valid
      if (validation.warnings.length > 0) {
        console.warn(
          `Plugin ${manifest.id} validation warnings:\n${formatValidationResult(validation)}`
        );
      }
    } catch (validationErr: unknown) {
      // Validation itself should never block loading
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      console.warn(`Plugin validation error (non-blocking) for ${pluginDir}: ${msg}`);
    }

    // Load entry module
    const entryPath = path.join(pluginDir, manifest.main);
    let entry: PluginEntry;

    try {
      // Check if entry file exists
      await fs.access(entryPath);

      // Dynamic import (supports both CommonJS and ESM)
      const module = await import(entryPath + '?t=' + Date.now());
      entry = module.default || module;

      if (typeof entry.activate !== 'function') {
        return {
          success: false,
          error: `Plugin ${manifest.id} has no activate function`,
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to load plugin entry: ${message}`,
      };
    }

    const loadedPlugin: LoadedPlugin = {
      manifest,
      rootPath: pluginDir,
      state: 'inactive',
      entry,
      registeredTools: [],
      registeredHooks: [],
    };

    return {
      success: true,
      plugin: loadedPlugin,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Discover and load all plugins from plugins directory
 */
export async function discoverPlugins(): Promise<LoadedPlugin[]> {
  await ensurePluginsDir();
  const pluginsDir = getPluginsDir();
  const plugins: LoadedPlugin[] = [];

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip hidden directories
      if (entry.name.startsWith('.')) continue;

      const pluginDir = path.join(pluginsDir, entry.name);
      const result = await loadPlugin(pluginDir);

      if (result.success && result.plugin) {
        plugins.push(result.plugin);
        console.log(`Loaded plugin: ${result.plugin.manifest.id}`);
      } else {
        console.warn(`Failed to load plugin from ${pluginDir}: ${result.error}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to discover plugins: ${message}`);
  }

  return plugins;
}

/**
 * Watch plugins directory for changes (hot reload)
 */
export function watchPluginsDir(
  onPluginAdded: (pluginDir: string) => void,
  onPluginRemoved: (pluginName: string) => void
): () => void {
  const pluginsDir = getPluginsDir();
  const watcher: fs.FileHandle | null = null;

  // Use fs.watch for directory changes
  const abortController = new AbortController();

  (async () => {
    try {
      const fsWatcher = fs.watch(pluginsDir, { signal: abortController.signal });
      for await (const event of fsWatcher) {
        if (event.eventType === 'rename' && event.filename) {
          const pluginPath = path.join(pluginsDir, event.filename);
          try {
            const stat = await fs.stat(pluginPath);
            if (stat.isDirectory()) {
              onPluginAdded(pluginPath);
            }
          } catch {
            // Directory was removed
            onPluginRemoved(event.filename);
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.error(`Plugin watcher error: ${errMsg}`);
      }
    }
  })();

  // Return cleanup function
  return () => {
    abortController.abort();
  };
}
