// ============================================================================
// Skill Plugin Install Service
// ============================================================================
// Handles installing, uninstalling, enabling, and disabling skill plugins
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../../services/infra/logger';
import { getMarketplaceInfo, listMarketplaces } from './marketplaceService';
import type {
  InstalledPluginRecord,
  InstalledPluginsFile,
  InstallResult,
  UninstallResult,
  PluginScope,
  PluginEntry,
} from './types';

const logger = createLogger('PluginInstallService');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const CONFIG_BASE_DIR = '.code-agent';
const INSTALLED_PLUGINS_FILE = 'installed-plugins.json';

// ----------------------------------------------------------------------------
// Path Utilities
// ----------------------------------------------------------------------------

function getUserConfigDir(): string {
  return path.join(os.homedir(), CONFIG_BASE_DIR);
}

function getProjectConfigDir(projectPath: string): string {
  return path.join(projectPath, CONFIG_BASE_DIR);
}

function getScopeBaseDir(scope: PluginScope, projectPath?: string): string {
  if (scope === 'user') return getUserConfigDir();
  if (!projectPath) throw new Error('Project path required for project scope');
  return getProjectConfigDir(projectPath);
}

function getSkillsDir(scope: PluginScope, projectPath?: string): string {
  return path.join(getScopeBaseDir(scope, projectPath), 'skills');
}

function getCommandsDir(scope: PluginScope, projectPath?: string): string {
  return path.join(getScopeBaseDir(scope, projectPath), 'commands');
}

function getInstalledPluginsPath(): string {
  return path.join(getUserConfigDir(), INSTALLED_PLUGINS_FILE);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// ----------------------------------------------------------------------------
// Installed Plugins State
// ----------------------------------------------------------------------------

async function loadInstalledPlugins(): Promise<InstalledPluginsFile> {
  try {
    const filePath = getInstalledPluginsPath();
    if (!fsSync.existsSync(filePath)) return {};
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return {};
  }
}

async function saveInstalledPlugins(state: InstalledPluginsFile): Promise<void> {
  await ensureDir(path.dirname(getInstalledPluginsPath()));
  await fs.writeFile(
    getInstalledPluginsPath(),
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );
}

// ----------------------------------------------------------------------------
// Plugin Spec Parsing
// ----------------------------------------------------------------------------

/**
 * Parse plugin spec: "pluginName@marketplaceName" or just "pluginName"
 */
export function parsePluginSpec(spec: string): {
  plugin: string;
  marketplace: string | null;
} {
  const trimmed = spec.trim();
  if (trimmed.includes('@')) {
    const parts = trimmed.split('@');
    if (parts.length !== 2) {
      throw new Error(`Invalid plugin spec: ${spec}`);
    }
    return {
      plugin: parts[0]!.trim(),
      marketplace: parts[1]!.trim() || null,
    };
  }
  return { plugin: trimmed, marketplace: null };
}

/**
 * Resolve plugin name to full spec (plugin@marketplace)
 */
async function resolvePluginSpec(pluginInput: string): Promise<{
  plugin: string;
  marketplace: string;
  pluginSpec: string;
  entry: PluginEntry;
  rootDir: string;
}> {
  const { plugin, marketplace } = parsePluginSpec(pluginInput);

  if (marketplace) {
    // Explicit marketplace specified
    const info = await getMarketplaceInfo(marketplace);
    const entry = info.manifest.plugins.find(p => p.name === plugin);
    if (!entry) {
      throw new Error(
        `Plugin '${plugin}' not found in marketplace '${marketplace}'`
      );
    }
    return {
      plugin,
      marketplace,
      pluginSpec: `${plugin}@${marketplace}`,
      entry,
      rootDir: info.rootDir,
    };
  }

  // Search all marketplaces
  const config = await listMarketplaces();
  const matches: Array<{
    plugin: string;
    marketplace: string;
    entry: PluginEntry;
    rootDir: string;
  }> = [];

  for (const [marketplaceName, marketplaceEntry] of Object.entries(config)) {
    try {
      const info = await getMarketplaceInfo(marketplaceName);
      const found = info.manifest.plugins.find(p => p.name === plugin);
      if (found) {
        matches.push({
          plugin,
          marketplace: marketplaceName,
          entry: found,
          rootDir: info.rootDir,
        });
      }
    } catch {
      // Ignore errors reading individual marketplaces
    }
  }

  if (matches.length === 0) {
    const available = Object.keys(config).sort().join(', ');
    throw new Error(
      `Plugin '${plugin}' not found in any marketplace. Available marketplaces: ${available || '(none)'}`
    );
  }

  if (matches.length > 1) {
    const options = matches.map(m => `${plugin}@${m.marketplace}`).join(', ');
    throw new Error(
      `Plugin '${plugin}' found in multiple marketplaces. Specify explicitly: ${options}`
    );
  }

  const match = matches[0]!;
  return {
    plugin: match.plugin,
    marketplace: match.marketplace,
    pluginSpec: `${match.plugin}@${match.marketplace}`,
    entry: match.entry,
    rootDir: match.rootDir,
  };
}

// ----------------------------------------------------------------------------
// Copy Utilities
// ----------------------------------------------------------------------------

async function copyDirectory(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Install a skill plugin
 */
export async function installPlugin(
  pluginInput: string,
  options: {
    scope?: PluginScope;
    projectPath?: string;
    force?: boolean;
  } = {}
): Promise<InstallResult> {
  const scope = options.scope || 'user';
  const projectPath = scope === 'project' ? options.projectPath || process.cwd() : undefined;

  const { plugin, marketplace, pluginSpec, entry, rootDir } =
    await resolvePluginSpec(pluginInput);

  const state = await loadInstalledPlugins();

  // Check if already installed
  const existing = state[pluginSpec];
  if (existing && !options.force) {
    throw new Error(
      `Plugin '${pluginSpec}' is already installed. Use --force to reinstall.`
    );
  }

  // Get source directory
  const entrySourceBase = path.resolve(rootDir, entry.source || './');

  // Setup destination directories
  const skillsDestBase = getSkillsDir(scope, projectPath);
  const commandsDestBase = path.join(getCommandsDir(scope, projectPath), plugin, marketplace);

  await ensureDir(skillsDestBase);
  await ensureDir(commandsDestBase);

  const installedSkills: string[] = [];
  const installedCommands: string[] = [];

  // Install skills
  const skillPaths = entry.skills || [];
  for (const relPath of skillPaths) {
    const src = path.join(entrySourceBase, relPath);
    if (!fsSync.existsSync(src)) {
      throw new Error(`Skill path not found: ${src}`);
    }

    const skillName = path.basename(src);
    const dest = path.join(skillsDestBase, skillName);

    if (fsSync.existsSync(dest) && !options.force) {
      throw new Error(`Skill destination already exists: ${dest}`);
    }

    if (fsSync.existsSync(dest)) {
      await fs.rm(dest, { recursive: true, force: true });
    }

    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      await copyDirectory(src, dest);
    } else {
      await ensureDir(path.dirname(dest));
      await fs.copyFile(src, dest);
    }

    installedSkills.push(skillName);
  }

  // Install commands
  const commandPaths = entry.commands || [];
  for (const relPath of commandPaths) {
    const src = path.join(entrySourceBase, relPath);
    if (!fsSync.existsSync(src)) {
      throw new Error(`Command path not found: ${src}`);
    }

    const commandName = path.basename(src);
    const dest = path.join(commandsDestBase, commandName);

    if (fsSync.existsSync(dest) && !options.force) {
      throw new Error(`Command destination already exists: ${dest}`);
    }

    if (fsSync.existsSync(dest)) {
      await fs.rm(dest, { recursive: true, force: true });
    }

    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      await copyDirectory(src, dest);
    } else {
      await ensureDir(path.dirname(dest));
      await fs.copyFile(src, dest);
    }

    installedCommands.push(dest);
  }

  // Update state
  state[pluginSpec] = {
    plugin,
    marketplace,
    scope,
    isEnabled: true,
    projectPath,
    installedAt: new Date().toISOString(),
    skills: installedSkills,
    commands: installedCommands,
    sourceMarketplacePath: rootDir,
  };

  await saveInstalledPlugins(state);

  logger.info('Plugin installed', {
    pluginSpec,
    skills: installedSkills.length,
    commands: installedCommands.length,
  });

  return { pluginSpec, installedSkills, installedCommands };
}

/**
 * Uninstall a skill plugin
 */
export async function uninstallPlugin(
  pluginInput: string,
  options: {
    scope?: PluginScope;
    projectPath?: string;
  } = {}
): Promise<UninstallResult> {
  const scope = options.scope || 'user';
  const projectPath = scope === 'project' ? options.projectPath || process.cwd() : undefined;

  const state = await loadInstalledPlugins();
  const { plugin, marketplace } = parsePluginSpec(pluginInput);

  // Find the plugin spec
  let pluginSpec: string;
  if (marketplace) {
    pluginSpec = `${plugin}@${marketplace}`;
  } else {
    // Find by plugin name
    const matches = Object.keys(state).filter(spec => spec.startsWith(`${plugin}@`));
    if (matches.length === 0) {
      throw new Error(`Plugin '${plugin}' is not installed`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple installations of '${plugin}' found. Specify marketplace: ${matches.join(', ')}`
      );
    }
    pluginSpec = matches[0]!;
  }

  const record = state[pluginSpec];
  if (!record) {
    throw new Error(`Plugin '${pluginSpec}' is not installed`);
  }

  if (record.scope !== scope) {
    throw new Error(
      `Plugin '${pluginSpec}' is installed with scope=${record.scope}. Use --scope ${record.scope}`
    );
  }

  // Remove skills
  const skillsDir = getSkillsDir(scope, projectPath);
  const removedSkills: string[] = [];
  for (const skillName of record.skills) {
    const skillPath = path.join(skillsDir, skillName);
    if (fsSync.existsSync(skillPath)) {
      await fs.rm(skillPath, { recursive: true, force: true });
      removedSkills.push(skillName);
    }
  }

  // Remove commands directory
  const commandsDir = path.join(
    getCommandsDir(scope, projectPath),
    record.plugin,
    record.marketplace
  );
  const removedCommands: string[] = [];
  if (fsSync.existsSync(commandsDir)) {
    await fs.rm(commandsDir, { recursive: true, force: true });
    removedCommands.push(commandsDir);
  }

  // Update state
  delete state[pluginSpec];
  await saveInstalledPlugins(state);

  logger.info('Plugin uninstalled', { pluginSpec });

  return { pluginSpec, removedSkills, removedCommands };
}

/**
 * List installed plugins
 */
export async function listInstalledPlugins(): Promise<InstalledPluginsFile> {
  return loadInstalledPlugins();
}

/**
 * Enable a disabled plugin
 */
export async function enablePlugin(pluginInput: string): Promise<void> {
  const state = await loadInstalledPlugins();
  const { plugin, marketplace } = parsePluginSpec(pluginInput);

  const pluginSpec = marketplace
    ? `${plugin}@${marketplace}`
    : Object.keys(state).find(spec => spec.startsWith(`${plugin}@`)) || '';

  const record = state[pluginSpec];
  if (!record) {
    throw new Error(`Plugin '${pluginSpec || pluginInput}' is not installed`);
  }

  record.isEnabled = true;
  state[pluginSpec] = record;
  await saveInstalledPlugins(state);

  logger.info('Plugin enabled', { pluginSpec });
}

/**
 * Disable a plugin (without uninstalling)
 */
export async function disablePlugin(pluginInput: string): Promise<void> {
  const state = await loadInstalledPlugins();
  const { plugin, marketplace } = parsePluginSpec(pluginInput);

  const pluginSpec = marketplace
    ? `${plugin}@${marketplace}`
    : Object.keys(state).find(spec => spec.startsWith(`${plugin}@`)) || '';

  const record = state[pluginSpec];
  if (!record) {
    throw new Error(`Plugin '${pluginSpec || pluginInput}' is not installed`);
  }

  record.isEnabled = false;
  state[pluginSpec] = record;
  await saveInstalledPlugins(state);

  logger.info('Plugin disabled', { pluginSpec });
}

/**
 * Get installed skills directories (only enabled plugins)
 */
export async function getEnabledSkillDirs(): Promise<string[]> {
  const state = await loadInstalledPlugins();
  const dirs: string[] = [];

  for (const record of Object.values(state)) {
    if (!record.isEnabled) continue;

    const skillsDir = getSkillsDir(record.scope, record.projectPath);
    for (const skillName of record.skills) {
      const skillDir = path.join(skillsDir, skillName);
      if (fsSync.existsSync(skillDir)) {
        dirs.push(skillDir);
      }
    }
  }

  return dirs;
}
