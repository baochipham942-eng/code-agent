// ============================================================================
// Plugin Loader - Load plugins from filesystem
// ============================================================================

import fs from 'fs/promises';
import { createRequire } from 'node:module';
import path from 'path';
import { pathToFileURL } from 'node:url';
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
import { verifyInstalledPluginTrust } from './pluginPackageTrust';
import { normalizePluginCapabilityDeclaration } from './pluginCapabilitySurface';
import {
  migrateLegacyPluginDirectory,
  readPluginVersionState,
  resolveStoredPluginRunDirectory,
} from './pluginPackageVersionStore';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

export const PLUGIN_MANIFEST_FILES = ['plugin.json', 'manifest.json', 'package.json'] as const;
const PLUGINS_DIR_NAME = 'plugins';
const pluginRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function normalizeManifest(value: unknown): PluginManifest | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readStringField(value, 'id') ?? readStringField(value, 'name');
  const version = readStringField(value, 'version');
  if (!id || !version) {
    return null;
  }

  return normalizePluginCapabilityDeclaration({
    ...(value as Partial<PluginManifest>),
    id,
    name: readStringField(value, 'name') ?? id,
    version,
    main: readStringField(value, 'main') ?? 'index.js',
    capabilities: normalizeStringArray(value.capabilities),
    nativeDeps: normalizeStringArray(value.nativeDeps),
  });
}

async function readPluginManifestValue(pluginDir: string): Promise<unknown | null> {
  for (const filename of PLUGIN_MANIFEST_FILES) {
    const manifestPath = path.join(pluginDir, filename);
    try {
      return parseJsonValue(await fs.readFile(manifestPath, 'utf-8')) ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return null;
}

function normalizePluginEntry(value: unknown): PluginEntry | null {
  const candidate = isRecord(value) && 'default' in value
    ? value.default
    : value;

  return isRecord(candidate) && typeof candidate.activate === 'function'
    ? candidate as unknown as PluginEntry
    : null;
}

async function importPluginEntry(entryPath: string): Promise<unknown> {
  const source = await fs.readFile(entryPath, 'utf8');
  const isCommonJs = path.extname(entryPath) === '.cjs'
    || /\bmodule\s*\.\s*exports\b|\bexports\s*\./.test(source);
  if (isCommonJs) {
    const resolved = pluginRequire.resolve(entryPath);
    delete pluginRequire.cache[resolved];
    return pluginRequire(resolved) as unknown;
  }
  return import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`) as Promise<unknown>;
}

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
export async function readPluginManifest(pluginDir: string): Promise<PluginManifest | null> {
  const manifest = normalizeManifest(await readPluginManifestValue(pluginDir));
  if (!manifest) {
    console.warn(`Invalid manifest in ${pluginDir}: missing id or version`);
  }
  return manifest;
}

/**
 * Load a single plugin from a directory
 */
export async function loadPlugin(pluginDir: string): Promise<PluginLoadResult> {
  try {
    // Read manifest
    const rawManifest = await readPluginManifestValue(pluginDir);
    if (!rawManifest) {
      return {
        success: false,
        error: `No valid manifest found in ${pluginDir}`,
      };
    }
    const manifest = normalizeManifest(rawManifest);
    if (!manifest) {
      return {
        success: false,
        error: `No valid manifest found in ${pluginDir}`,
      };
    }

    // Structured validation
    try {
      const validation = await validatePlugin(pluginDir, rawManifest);
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
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      return {
        success: false,
        error: `Plugin validation could not complete in ${pluginDir}: ${msg}`,
      };
    }

    await verifyInstalledPluginTrust(pluginDir, manifest);

    // Load entry module
    const entryPath = path.join(pluginDir, manifest.main);
    let entry: PluginEntry;

    try {
      // Check if entry file exists
      await fs.access(entryPath);

      // CommonJS needs explicit require-cache invalidation; query strings only bust ESM imports.
      const module = await importPluginEntry(entryPath);
      const normalizedEntry = normalizePluginEntry(module);

      if (!normalizedEntry) {
        return {
          success: false,
          error: `Plugin ${manifest.id} has no activate function`,
        };
      }

      entry = normalizedEntry;
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

async function prepareDiscoveredPluginDirectory(pluginRoot: string): Promise<string | null> {
  const existingState = await readPluginVersionState(pluginRoot);
  if (!existingState) {
    const manifest = await readPluginManifest(pluginRoot);
    if (!manifest) return pluginRoot;
    const trust = await verifyInstalledPluginTrust(pluginRoot, manifest);
    await migrateLegacyPluginDirectory(pluginRoot, manifest, {
      packageHash: trust.packageHash,
      sourceTrust: trust.sourceTrust,
      now: Date.now(),
    });
  }
  return resolveStoredPluginRunDirectory(pluginRoot);
}

/**
 * Discover and load all plugins from plugins directory
 */
export async function discoverPlugins(
  onFailure: (pluginDir: string, error: string) => void = () => undefined,
): Promise<LoadedPlugin[]> {
  await ensurePluginsDir();
  const pluginsDir = getPluginsDir();
  const plugins: LoadedPlugin[] = [];

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip hidden directories
      if (entry.name.startsWith('.')) continue;

      const pluginRoot = path.join(pluginsDir, entry.name);
      const pluginDir = await prepareDiscoveredPluginDirectory(pluginRoot);
      if (!pluginDir) continue;
      const result = await loadPlugin(pluginDir);

      if (result.success && result.plugin) {
        plugins.push(result.plugin);
        console.log(`Loaded plugin: ${result.plugin.manifest.id}`);
      } else {
        const error = result.error ?? 'load failed';
        onFailure(pluginDir, error);
        console.warn(`Failed to load plugin from ${pluginDir}: ${error}`);
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
              const pluginDir = await prepareDiscoveredPluginDirectory(pluginPath);
              if (pluginDir) onPluginAdded(pluginDir);
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
