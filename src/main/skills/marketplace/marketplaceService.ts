// ============================================================================
// Skill Marketplace Service
// ============================================================================
// Manages skill marketplaces: add, remove, refresh, list plugins
// Based on Kode-cli skill marketplace design
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { createLogger } from '../../services/infra/logger';
import type {
  MarketplaceSource,
  MarketplaceManifest,
  KnownMarketplacesConfig,
  KnownMarketplaceEntry,
  PluginEntry,
} from './types';
import {
  MarketplaceManifestSchema,
  MarketplaceSourceSchema,
  KnownMarketplacesSchema,
} from './types';

const logger = createLogger('MarketplaceService');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const CONFIG_BASE_DIR = '.code-agent';
const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json';
const MARKETPLACES_CACHE_DIR = 'marketplaces';

// ----------------------------------------------------------------------------
// Path Utilities
// ----------------------------------------------------------------------------

function getUserConfigDir(): string {
  return path.join(os.homedir(), CONFIG_BASE_DIR);
}

function getMarketplacesDir(): string {
  return path.join(getUserConfigDir(), MARKETPLACES_CACHE_DIR);
}

function getKnownMarketplacesPath(): string {
  return path.join(getUserConfigDir(), KNOWN_MARKETPLACES_FILE);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// ----------------------------------------------------------------------------
// JSON File Utilities
// ----------------------------------------------------------------------------

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    if (!fsSync.existsSync(filePath)) return fallback;
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// ----------------------------------------------------------------------------
// Marketplace Manifest Reading
// ----------------------------------------------------------------------------

async function readMarketplaceManifest(rootDir: string): Promise<MarketplaceManifest> {
  const primaryPath = path.join(rootDir, '.code-agent-plugin', 'marketplace.json');
  const alternatePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
  const kodePath = path.join(rootDir, '.kode-plugin', 'marketplace.json');

  let manifestPath: string | null = null;

  for (const p of [primaryPath, alternatePath, kodePath]) {
    if (fsSync.existsSync(p)) {
      manifestPath = p;
      break;
    }
  }

  if (!manifestPath) {
    throw new Error(
      `Marketplace manifest not found. Expected .code-agent-plugin/marketplace.json, .claude-plugin/marketplace.json, or .kode-plugin/marketplace.json in ${rootDir}`
    );
  }

  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = MarketplaceManifestSchema.safeParse(JSON.parse(raw));

  if (!parsed.success) {
    throw new Error(
      `Invalid marketplace.json: ${parsed.error.issues.map(i => i.message).join('; ')}`
    );
  }

  return parsed.data;
}

// ----------------------------------------------------------------------------
// Source Parsing
// ----------------------------------------------------------------------------

function parseMarketplaceSource(input: string): MarketplaceSource {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Marketplace source is required');

  // Check for explicit prefixes
  if (trimmed.startsWith('github:')) {
    const rest = trimmed.slice(7).trim();
    const [repoPath, refPart] = rest.split('@');
    const [repo, subPath] = (repoPath || '').split('#');
    return {
      source: 'github',
      repo: repo || '',
      ref: refPart || undefined,
      path: subPath || undefined,
    };
  }

  if (trimmed.startsWith('npm:')) {
    return { source: 'npm', package: trimmed.slice(4).trim() };
  }

  if (trimmed.startsWith('url:')) {
    return { source: 'url', url: trimmed.slice(4).trim() };
  }

  if (trimmed.startsWith('dir:')) {
    return { source: 'directory', path: trimmed.slice(4).trim() };
  }

  // Check if it's a local path
  const resolved = path.resolve(trimmed);
  if (fsSync.existsSync(resolved)) {
    const stat = fsSync.lstatSync(resolved);
    if (stat.isDirectory()) {
      return { source: 'directory', path: resolved };
    }
  }

  // Check if it looks like a GitHub repo (owner/repo format)
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    const [repoPath, refPart] = trimmed.split('@');
    const [repo, subPath] = (repoPath || '').split('#');
    return {
      source: 'github',
      repo: repo || '',
      ref: refPart || undefined,
      path: subPath || undefined,
    };
  }

  // Check if it's a URL
  if (/^https?:\/\//.test(trimmed)) {
    return { source: 'url', url: trimmed };
  }

  throw new Error(
    `Unsupported marketplace source: ${input}. Use a local path, "owner/repo", or prefixes like github:, npm:, url:, dir:`
  );
}

// ----------------------------------------------------------------------------
// GitHub Download
// ----------------------------------------------------------------------------

async function downloadGitHubZip(repo: string, ref: string): Promise<Buffer> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid GitHub repo: ${repo}`);

  const refs = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];

  let lastError: Error | null = null;

  for (const candidate of refs) {
    const url = `https://codeload.github.com/${owner}/${name}/zip/${candidate}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error(`Failed to download GitHub repo ${repo}@${ref}`);
}

// ----------------------------------------------------------------------------
// Cache Marketplace
// ----------------------------------------------------------------------------

async function cacheMarketplaceToDir(
  source: MarketplaceSource,
  destDir: string
): Promise<void> {
  // Clean destination
  if (fsSync.existsSync(destDir)) {
    await fs.rm(destDir, { recursive: true, force: true });
  }
  await ensureDir(destDir);

  if (source.source === 'directory') {
    // Copy directory contents
    const srcDir = path.resolve(source.path);
    if (!fsSync.existsSync(srcDir)) {
      throw new Error(`Directory not found: ${source.path}`);
    }
    await copyDirectory(srcDir, destDir);
    return;
  }

  if (source.source === 'github') {
    const refsToTry = source.ref ? [source.ref] : ['main', 'master'];
    let zip: Buffer | null = null;

    for (const ref of refsToTry) {
      try {
        zip = await downloadGitHubZip(source.repo, ref);
        break;
      } catch {
        // Try next ref
      }
    }

    if (!zip) {
      throw new Error(`Failed to download GitHub repo ${source.repo}`);
    }

    // Extract zip using native unzip or node-based extraction
    // For simplicity, we'll use a temporary file and shell command
    const tempZip = path.join(destDir, '..', `temp-${randomUUID()}.zip`);
    await fs.writeFile(tempZip, zip);

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      await execAsync(`unzip -q "${tempZip}" -d "${destDir}"`);

      // Move contents from nested directory to root
      const entries = await fs.readdir(destDir);
      if (entries.length === 1) {
        const nested = path.join(destDir, entries[0]!);
        const stat = await fs.stat(nested);
        if (stat.isDirectory()) {
          // If there's a subpath, use that
          const sourceDir = source.path
            ? path.join(nested, source.path)
            : nested;

          if (!fsSync.existsSync(sourceDir)) {
            throw new Error(`Path not found in repo: ${source.path}`);
          }

          // Move contents up
          const nestedEntries = await fs.readdir(sourceDir);
          for (const entry of nestedEntries) {
            await fs.rename(
              path.join(sourceDir, entry),
              path.join(destDir, entry)
            );
          }
          await fs.rm(nested, { recursive: true });
        }
      }
    } finally {
      await fs.unlink(tempZip).catch(() => {});
    }

    return;
  }

  if (source.source === 'url') {
    if (source.url.toLowerCase().endsWith('.json')) {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${source.url}`);
      }
      const content = await response.text();
      const manifestDir = path.join(destDir, '.code-agent-plugin');
      await ensureDir(manifestDir);
      await fs.writeFile(path.join(manifestDir, 'marketplace.json'), content);
      return;
    }
    throw new Error(`URL marketplace must end with .json: ${source.url}`);
  }

  if (source.source === 'npm') {
    throw new Error(`npm marketplace sources are not supported yet: ${source.package}`);
  }
}

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
// Known Marketplaces Management
// ----------------------------------------------------------------------------

async function loadKnownMarketplaces(): Promise<KnownMarketplacesConfig> {
  const raw = await readJsonFile<unknown>(getKnownMarketplacesPath(), {});
  const parsed = KnownMarketplacesSchema.safeParse(raw);

  if (!parsed.success) {
    logger.warn('Corrupted marketplaces config, resetting');
    return {};
  }

  return parsed.data;
}

async function saveKnownMarketplaces(config: KnownMarketplacesConfig): Promise<void> {
  await writeJsonFile(getKnownMarketplacesPath(), config);
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * List all known marketplaces
 */
export async function listMarketplaces(): Promise<KnownMarketplacesConfig> {
  return loadKnownMarketplaces();
}

/**
 * Add a new marketplace
 */
export async function addMarketplace(sourceInput: string): Promise<{ name: string }> {
  const source = parseMarketplaceSource(sourceInput);
  const validated = MarketplaceSourceSchema.safeParse(source);

  if (!validated.success) {
    throw new Error(
      `Invalid marketplace source: ${validated.error.issues.map(i => i.message).join('; ')}`
    );
  }

  const config = await loadKnownMarketplaces();
  const cacheBase = getMarketplacesDir();
  await ensureDir(cacheBase);

  const tempDir = path.join(cacheBase, `tmp-${randomUUID()}`);

  try {
    await cacheMarketplaceToDir(validated.data, tempDir);
    const manifest = await readMarketplaceManifest(tempDir);
    const marketplaceName = manifest.name;

    if (config[marketplaceName]) {
      throw new Error(
        `Marketplace '${marketplaceName}' is already installed. Remove it first to re-add.`
      );
    }

    const installLocation = path.join(cacheBase, marketplaceName);
    if (fsSync.existsSync(installLocation)) {
      throw new Error(`Marketplace cache directory already exists: ${installLocation}`);
    }

    await fs.rename(tempDir, installLocation);

    config[marketplaceName] = {
      source: validated.data,
      installLocation,
      lastUpdated: new Date().toISOString(),
    };

    await saveKnownMarketplaces(config);

    logger.info('Marketplace added', { name: marketplaceName, source: sourceInput });
    return { name: marketplaceName };
  } catch (error) {
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Remove a marketplace
 */
export async function removeMarketplace(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Marketplace name is required');

  const config = await loadKnownMarketplaces();
  const entry = config[trimmed];

  if (!entry) {
    throw new Error(`Marketplace '${trimmed}' not found`);
  }

  delete config[trimmed];
  await saveKnownMarketplaces(config);

  try {
    if (fsSync.existsSync(entry.installLocation)) {
      await fs.rm(entry.installLocation, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }

  logger.info('Marketplace removed', { name: trimmed });
}

/**
 * Refresh a marketplace (re-download from source)
 */
export async function refreshMarketplace(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Marketplace name is required');

  const config = await loadKnownMarketplaces();
  const entry = config[trimmed];

  if (!entry) {
    throw new Error(`Marketplace '${trimmed}' not found`);
  }

  const cacheBase = getMarketplacesDir();
  const tempDir = path.join(cacheBase, `tmp-${randomUUID()}`);

  try {
    await cacheMarketplaceToDir(entry.source, tempDir);
    const manifest = await readMarketplaceManifest(tempDir);

    if (manifest.name !== trimmed) {
      throw new Error(
        `Marketplace name mismatch: expected ${trimmed}, got ${manifest.name}`
      );
    }

    if (fsSync.existsSync(entry.installLocation)) {
      await fs.rm(entry.installLocation, { recursive: true, force: true });
    }

    await fs.rename(tempDir, entry.installLocation);

    config[trimmed] = {
      ...entry,
      lastUpdated: new Date().toISOString(),
    };

    await saveKnownMarketplaces(config);
    logger.info('Marketplace refreshed', { name: trimmed });
  } catch (error) {
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Get marketplace manifest and metadata
 */
export async function getMarketplaceInfo(name: string): Promise<{
  manifest: MarketplaceManifest;
  rootDir: string;
  source: MarketplaceSource;
}> {
  const config = await loadKnownMarketplaces();
  const entry = config[name];

  if (!entry) {
    const available = Object.keys(config).sort().join(', ');
    throw new Error(
      `Marketplace '${name}' not found. Available: ${available || '(none)'}`
    );
  }

  const manifest = await readMarketplaceManifest(entry.installLocation);
  return { manifest, rootDir: entry.installLocation, source: entry.source };
}

/**
 * List all plugins across all marketplaces
 */
export async function listAllPlugins(): Promise<
  Array<{ plugin: PluginEntry; marketplace: string }>
> {
  const config = await loadKnownMarketplaces();
  const results: Array<{ plugin: PluginEntry; marketplace: string }> = [];

  for (const [marketplaceName, entry] of Object.entries(config)) {
    try {
      const manifest = await readMarketplaceManifest(entry.installLocation);
      for (const plugin of manifest.plugins) {
        results.push({ plugin, marketplace: marketplaceName });
      }
    } catch (error) {
      logger.warn('Failed to read marketplace', { name: marketplaceName, error });
    }
  }

  return results;
}

/**
 * Search plugins by name or description
 */
export async function searchPlugins(
  query: string
): Promise<Array<{ plugin: PluginEntry; marketplace: string }>> {
  const allPlugins = await listAllPlugins();
  const lowerQuery = query.toLowerCase();

  return allPlugins.filter(
    ({ plugin }) =>
      plugin.name.toLowerCase().includes(lowerQuery) ||
      plugin.description?.toLowerCase().includes(lowerQuery) ||
      plugin.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}
