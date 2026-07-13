// ============================================================================
// Skill Plugin Install Service
// ============================================================================
// Handles installing, uninstalling, enabling, and disabling skill plugins
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getUserConfigDir as getBaseConfigDir, getProjectConfigDir as getBaseProjectConfigDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';
import { getMarketplaceInfo, listMarketplaces } from './marketplaceService';
import type {
  PluginEntryKind,
  InstalledPluginRecord,
  InstalledPluginsFile,
  InstallResult,
  UninstallResult,
  PluginScope,
  PluginEntry,
} from './types';
import {
  assertTrustedArchiveHash,
  downloadArchive,
  extractZipSafely,
  getArchiveSha256,
} from './githubArchiveSecurity';

const logger = createLogger('PluginInstallService');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const INSTALLED_PLUGINS_FILE = 'installed-plugins.json';

// ----------------------------------------------------------------------------
// Path Utilities
// ----------------------------------------------------------------------------

function getUserConfigDir(): string {
  return getBaseConfigDir();
}

function getProjectConfigDir(projectPath: string): string {
  return getBaseProjectConfigDir(projectPath);
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

function getPluginAssetsDir(scope: PluginScope, projectPath?: string): string {
  return path.join(getScopeBaseDir(scope, projectPath), 'plugins');
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

function normalizePluginKind(value: unknown): PluginEntryKind | null {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'skill':
      return 'skill';
    case 'command':
    case 'commands':
      return 'command';
    case 'ui':
      return 'ui';
    case 'theme':
      return 'theme';
    case 'provider':
      return 'provider';
    case 'tool':
      return 'tool';
    case 'transform':
      return 'transform';
    default:
      return null;
  }
}

function getPluginEntryTypes(entry: PluginEntry): PluginEntryKind[] {
  const rawTypes = [
    ...(entry.types ?? []),
    ...(Array.isArray(entry.type) ? entry.type : entry.type ? [entry.type] : []),
  ];
  const types = rawTypes
    .map(normalizePluginKind)
    .filter((value): value is PluginEntryKind => Boolean(value));

  if ((entry.skills ?? []).length > 0) {
    types.push('skill');
  }
  if ((entry.commands ?? []).length > 0) {
    types.push('command');
  }
  if (types.length === 0) {
    types.push('skill');
  }
  return Array.from(new Set(types));
}

function getPluginAssetDirName(pluginSpec: string): string {
  return pluginSpec
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '-')
    .replace(/@/g, '__')
    .replace(/^-+|-+$/g, '') || 'plugin';
}

function getPluginAssetDestination(scope: PluginScope, projectPath: string | undefined, pluginSpec: string): string {
  return path.join(getPluginAssetsDir(scope, projectPath), getPluginAssetDirName(pluginSpec));
}

function parseGitHubRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) {
    return null;
  }
  const trimmed = repository.trim().replace(/\.git$/, '');
  const match = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)$/)
    ?? trimmed.match(/^github:([^/\s]+)\/([^/\s#?]+)$/)
    ?? trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
  if (!match) {
    return null;
  }
  return { owner: match[1]!, repo: match[2]! };
}

async function resolveGitHubBranchCommit(
  owner: string,
  repo: string,
): Promise<string> {
  const refs = ['main', 'master'];
  let lastError: Error | null = null;

  for (const ref of refs) {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (response.ok) {
        const body = await response.json() as { sha?: unknown };
        if (typeof body.sha === 'string' && /^[0-9a-f]{40}$/i.test(body.sha)) {
          return body.sha;
        }
        lastError = new Error(`GitHub returned an invalid commit SHA for ${owner}/${repo}@${ref}`);
      } else {
        lastError = new Error(`GitHub API returned ${response.status} for ${owner}/${repo}@${ref}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Fail closed: following a moving branch would defeat pinning. A transient API
  // failure is safe to retry and must never silently fall back to refs/heads.
  throw new Error(
    `Unable to resolve an immutable GitHub commit for ${owner}/${repo}; retry the installation. ${lastError?.message ?? ''}`.trim(),
  );
}

async function downloadGitHubRepository(
  owner: string,
  repo: string,
  destDir: string,
): Promise<{ pinnedCommit: string; contentHash: string }> {
  const pinnedCommit = await resolveGitHubBranchCommit(owner, repo);
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${pinnedCommit}`;
  const archive = await downloadArchive(url);
  const contentHash = getArchiveSha256(archive);
  await ensureDir(destDir);
  try {
    await extractZipSafely(archive, destDir);
    const entries = await fs.readdir(destDir);
    if (entries.length === 1) {
      const nested = path.join(destDir, entries[0]!);
      const stat = await fs.stat(nested);
      if (stat.isDirectory()) {
        const nestedEntries = await fs.readdir(nested);
        for (const entry of nestedEntries) {
          await fs.rename(path.join(nested, entry), path.join(destDir, entry));
        }
        await fs.rm(nested, { recursive: true, force: true });
      }
    }
  } catch (error) {
    await fs.rm(destDir, { recursive: true, force: true });
    throw error;
  }
  return { pinnedCommit, contentHash };
}

async function resolveEntrySourceBase(args: {
  rootDir: string;
  entry: PluginEntry;
  pluginSpec: string;
}): Promise<{
  sourceBase: string;
  cleanup?: () => Promise<void>;
  pinnedCommit?: string;
  contentHash?: string;
}> {
  const sourcePath = args.entry.source || args.entry.path || './';
  const localSourceBase = path.resolve(args.rootDir, sourcePath);
  if (fsSync.existsSync(localSourceBase)) {
    return { sourceBase: localSourceBase };
  }

  const github = parseGitHubRepository(args.entry.repository);
  if (!github) {
    return { sourceBase: localSourceBase };
  }

  const tempDir = path.join(getUserConfigDir(), 'marketplace-plugin-cache', `tmp-${getPluginAssetDirName(args.pluginSpec)}-${randomUUID()}`);
  const artifact = await downloadGitHubRepository(github.owner, github.repo, tempDir);
  const remoteSourceBase = path.resolve(tempDir, args.entry.path || args.entry.source || './');
  if (!fsSync.existsSync(remoteSourceBase)) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`Plugin path not found in repository: ${args.entry.path || args.entry.source || './'}`);
  }
  return {
    sourceBase: remoteSourceBase,
    ...artifact,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function installPluginAssets(args: {
  entrySourceBase: string;
  scope: PluginScope;
  projectPath?: string;
  pluginSpec: string;
  force?: boolean;
}): Promise<string> {
  const stat = await fs.stat(args.entrySourceBase);
  if (!stat.isDirectory()) {
    throw new Error(`Plugin source must be a directory: ${args.entrySourceBase}`);
  }

  const pluginRoot = getPluginAssetDestination(args.scope, args.projectPath, args.pluginSpec);
  if (fsSync.existsSync(pluginRoot) && !args.force) {
    throw new Error(`Plugin asset destination already exists: ${pluginRoot}`);
  }
  if (fsSync.existsSync(pluginRoot)) {
    await fs.rm(pluginRoot, { recursive: true, force: true });
  }
  await copyDirectory(args.entrySourceBase, pluginRoot);
  return pluginRoot;
}

function getCommandNameFromFile(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename.endsWith('.md')) {
    throw new Error(`Command file must be a .md file: ${filePath}`);
  }
  const commandName = basename.slice(0, -3).trim();
  if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(commandName)) {
    throw new Error(`Invalid command file name: ${basename}`);
  }
  return commandName;
}

function resolveInside(baseDir: string, candidatePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(baseDir, candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Command path must stay inside plugin source: ${candidatePath}`);
  }
  return resolvedCandidate;
}

function assertInside(baseDir: string, candidatePath: string, label: string): void {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside marketplace root: ${candidatePath}`);
  }
}

async function resolveCommandFiles(args: {
  rootDir: string;
  entrySourceBase: string;
  commandPaths: string[];
}): Promise<Array<{ name: string; sourcePath: string; relativeSourcePath: string }>> {
  const commands: Array<{ name: string; sourcePath: string; relativeSourcePath: string }> = [];

  for (const relPath of args.commandPaths) {
    const sourcePath = resolveInside(args.entrySourceBase, relPath);
    assertInside(args.rootDir, sourcePath, 'Command file');
    if (!fsSync.existsSync(sourcePath)) {
      throw new Error(`Command file not found: ${sourcePath}`);
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new Error(`Command path must be a file: ${sourcePath}`);
    }
    commands.push({
      name: getCommandNameFromFile(sourcePath),
      sourcePath,
      relativeSourcePath: path.relative(args.rootDir, sourcePath),
    });
  }

  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Duplicate command names in plugin: ${names.join(', ')}`);
  }

  return commands;
}

async function activatePluginCommands(args: {
  rootDir: string;
  scope: PluginScope;
  projectPath?: string;
  commandPaths: string[];
}): Promise<string[]> {
  if (args.commandPaths.length === 0) {
    return [];
  }

  const commandsDir = getCommandsDir(args.scope, args.projectPath);
  await ensureDir(commandsDir);
  const copied: string[] = [];

  try {
    for (const relativeSourcePath of args.commandPaths) {
      const sourcePath = resolveInside(args.rootDir, relativeSourcePath);
      if (!fsSync.existsSync(sourcePath)) {
        throw new Error(`Command file not found: ${sourcePath}`);
      }
      const commandName = getCommandNameFromFile(sourcePath);
      const destination = path.join(commandsDir, `${commandName}.md`);
      if (fsSync.existsSync(destination)) {
        throw new Error(`Command destination already exists: ${destination}`);
      }
      await fs.copyFile(sourcePath, destination);
      copied.push(commandName);
    }
  } catch (error) {
    for (const commandName of copied) {
      await fs.rm(path.join(commandsDir, `${commandName}.md`), { force: true }).catch(() => {});
    }
    throw error;
  }

  return copied;
}

async function deactivatePluginCommands(args: {
  scope: PluginScope;
  projectPath?: string;
  commandNames: string[];
}): Promise<string[]> {
  if (args.commandNames.length === 0) {
    return [];
  }

  const commandsDir = getCommandsDir(args.scope, args.projectPath);
  const removed: string[] = [];
  for (const commandName of args.commandNames) {
    const destination = path.join(commandsDir, `${commandName}.md`);
    if (fsSync.existsSync(destination)) {
      await fs.rm(destination, { force: true });
      removed.push(commandName);
    }
  }
  return removed;
}

async function resolveSkillDirs(args: {
  rootDir: string;
  entrySourceBase: string;
  skillPaths: string[];
}): Promise<Array<{ name: string; sourcePath: string; relativeSourcePath: string }>> {
  const skills: Array<{ name: string; sourcePath: string; relativeSourcePath: string }> = [];

  for (const relPath of args.skillPaths) {
    const sourcePath = resolveInside(args.entrySourceBase, relPath);
    assertInside(args.rootDir, sourcePath, 'Skill path');
    if (!fsSync.existsSync(sourcePath)) {
      throw new Error(`Skill path not found: ${sourcePath}`);
    }

    const stat = await fs.stat(sourcePath);
    const skillDir = stat.isDirectory() ? sourcePath : path.dirname(sourcePath);
    const skillMd = stat.isDirectory() ? path.join(sourcePath, 'SKILL.md') : sourcePath;
    if (!fsSync.existsSync(skillMd) || path.basename(skillMd) !== 'SKILL.md') {
      throw new Error(`Skill path must be a skill directory or SKILL.md file: ${sourcePath}`);
    }

    skills.push({
      name: path.basename(skillDir),
      sourcePath: skillDir,
      relativeSourcePath: path.relative(args.rootDir, skillDir),
    });
  }

  const names = skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Duplicate skill names in plugin: ${names.join(', ')}`);
  }

  return skills;
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
    enableAfterInstall?: boolean;
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
  const entrySource = await resolveEntrySourceBase({
    rootDir,
    entry,
    pluginSpec,
  });

  let installedAssetRoot: string | undefined;
  try {
    assertTrustedArchiveHash(
      existing?.contentHash,
      entrySource.contentHash ?? existing?.contentHash ?? '',
    );

    if (existing && options.force) {
      await deactivatePluginCommands({
        scope: existing.scope,
        projectPath: existing.projectPath,
        commandNames: existing.commands || [],
      });
      if (existing.pluginRoot && fsSync.existsSync(existing.pluginRoot)) {
        await fs.rm(existing.pluginRoot, { recursive: true, force: true });
      }
    }

    const pluginRoot = await installPluginAssets({
      entrySourceBase: entrySource.sourceBase,
      scope,
      projectPath,
      pluginSpec,
      force: options.force,
    });
    installedAssetRoot = pluginRoot;
    const pluginTypes = getPluginEntryTypes(entry);

    const skillDirs = await resolveSkillDirs({
      rootDir: pluginRoot,
      entrySourceBase: pluginRoot,
      skillPaths: entry.skills || [],
    });
    const installedSkills = skillDirs.map((skill) => skill.name);
    const commandFiles = await resolveCommandFiles({
      rootDir: pluginRoot,
      entrySourceBase: pluginRoot,
      commandPaths: entry.commands || [],
    });
    const installedCommands = commandFiles.map((command) => command.name);

    if (options.enableAfterInstall === true) {
      await activatePluginCommands({
        rootDir: pluginRoot,
        scope,
        projectPath,
        commandPaths: commandFiles.map((command) => command.relativeSourcePath),
      });
    }

    // Update state
    state[pluginSpec] = {
      plugin,
      marketplace,
      scope,
      isEnabled: options.enableAfterInstall === true,
      projectPath,
      installedAt: new Date().toISOString(),
      pinnedCommit: entrySource.pinnedCommit,
      contentHash: entrySource.contentHash,
      pluginRoot,
      types: pluginTypes,
      skills: installedSkills,
      skillPaths: skillDirs.map((skill) => skill.relativeSourcePath),
      commands: installedCommands,
      commandPaths: commandFiles.map((command) => command.relativeSourcePath),
      sourceMarketplacePath: pluginRoot,
    };

    await saveInstalledPlugins(state);

    logger.info('Plugin installed', {
      pluginSpec,
      isEnabled: state[pluginSpec].isEnabled,
      types: pluginTypes,
      skills: installedSkills.length,
      commands: installedCommands.length,
    });

    return { pluginSpec, installedSkills, installedCommands, installedPluginRoot: pluginRoot };
  } catch (error) {
    if (installedAssetRoot) {
      await fs.rm(installedAssetRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await entrySource.cleanup?.();
  }
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

  // Remove legacy copied skills if this record came from an older build.
  const effectiveScope = record.scope;
  const effectiveProjectPath = record.projectPath;
  const skillsDir = getSkillsDir(effectiveScope, effectiveProjectPath);
  const removedSkills: string[] = [];
  for (const skillName of record.skills) {
    const skillPath = path.join(skillsDir, skillName);
    if (fsSync.existsSync(skillPath)) {
      await fs.rm(skillPath, { recursive: true, force: true });
      removedSkills.push(skillName);
    }
  }
  const removedCommands = await deactivatePluginCommands({
    scope: effectiveScope,
    projectPath: effectiveProjectPath,
    commandNames: record.commands || [],
  });
  let removedPluginRoot: string | undefined;
  if (record.pluginRoot && fsSync.existsSync(record.pluginRoot)) {
    await fs.rm(record.pluginRoot, { recursive: true, force: true });
    removedPluginRoot = record.pluginRoot;
  }

  // Update state
  delete state[pluginSpec];
  await saveInstalledPlugins(state);

  logger.info('Plugin uninstalled', { pluginSpec });

  return { pluginSpec, removedSkills, removedCommands, removedPluginRoot };
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

  if (record.isEnabled) {
    logger.info('Plugin already enabled', { pluginSpec });
    return;
  }

  await activatePluginCommands({
    rootDir: record.sourceMarketplacePath,
    scope: record.scope,
    projectPath: record.projectPath,
    commandPaths: record.commandPaths || [],
  });
  record.isEnabled = true;
  state[pluginSpec] = record;
  await saveInstalledPlugins(state);

  // Trigger skill discovery reload so changes take effect immediately
  const { getSkillDiscoveryService } = await import('../../services/skills/skillDiscoveryService');
  const discoveryService = getSkillDiscoveryService();
  if (discoveryService) {
    await discoveryService.reload();
  }

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

  await deactivatePluginCommands({
    scope: record.scope,
    projectPath: record.projectPath,
    commandNames: record.commands || [],
  });
  record.isEnabled = false;
  state[pluginSpec] = record;
  await saveInstalledPlugins(state);

  // Trigger skill discovery reload so changes take effect immediately
  const { getSkillDiscoveryService } = await import('../../services/skills/skillDiscoveryService');
  const discoveryService = getSkillDiscoveryService();
  if (discoveryService) {
    await discoveryService.reload();
  }

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

    const pluginRoot = record.pluginRoot || record.sourceMarketplacePath;
    if (pluginRoot && record.skillPaths?.length) {
      for (const relPath of record.skillPaths) {
        const skillDir = resolveInside(pluginRoot, relPath);
        if (fsSync.existsSync(skillDir)) {
          dirs.push(skillDir);
        }
      }
      continue;
    }

    // Backward compatibility for records created before managed plugin roots
    // owned skill exposure.
    const skillsDir = getSkillsDir(record.scope, record.projectPath);
    for (const skillName of record.skills || []) {
      const legacySkillDir = path.join(skillsDir, skillName);
      if (fsSync.existsSync(legacySkillDir)) {
        dirs.push(legacySkillDir);
      }
    }
  }

  return dirs;
}
