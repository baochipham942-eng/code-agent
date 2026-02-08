// ============================================================================
// Git Downloader - Download GitHub repositories without git CLI
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream, createReadStream } from 'fs';
import { Readable } from 'stream';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createLogger } from '../infra/logger';

const logger = createLogger('GitDownloader');

// Proxy configuration
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY =
  !!PROXY_URL &&
  process.env.NO_PROXY !== 'true' &&
  process.env.DISABLE_PROXY !== 'true';
const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

// ============================================================================
// Types
// ============================================================================

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  branch: string;
}

export interface DownloadOptions {
  owner: string;
  repo: string;
  branch: string;
  targetDir: string;
  skillsPath?: string;
}

export interface DownloadResult {
  success: boolean;
  localPath: string;
  commitHash?: string;
  error?: string;
}

export interface RepoMeta {
  owner: string;
  repo: string;
  branch: string;
  commitHash: string;
  downloadedAt: number;
  lastUpdated: number;
  skillsPath?: string;
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse GitHub URL into components
 *
 * Supported formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch
 * - github.com/owner/repo
 * - owner/repo
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Remove leading/trailing whitespace
  url = url.trim();

  // Pattern for full URLs
  const fullUrlPattern =
    /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?(?:\/.*)?$/i;

  // Pattern for short format (owner/repo)
  const shortPattern = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/;

  let match = url.match(fullUrlPattern);
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      branch: match[3] || 'main',
    };
  }

  match = url.match(shortPattern);
  if (match) {
    return {
      owner: match[1],
      repo: match[2],
      branch: 'main',
    };
  }

  return null;
}

// ============================================================================
// GitHub API
// ============================================================================

/**
 * Get the latest commit hash for a branch
 */
export async function getLatestCommit(
  owner: string,
  repo: string,
  branch: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Code-Agent/1.0',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      httpsAgent,
      timeout: 30000,
    });

    return response.data.sha;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        logger.warn('Repository or branch not found', { owner, repo, branch });
        return null;
      }
      if (error.response?.status === 403) {
        logger.warn('GitHub API rate limit exceeded or access denied');
        return null;
      }
    }
    logger.error('Failed to get latest commit', error);
    return null;
  }
}

// ============================================================================
// Tarball Extraction
// ============================================================================

/**
 * Extract a tar.gz file to a directory using system tar command
 * Falls back to custom parser if tar is not available
 */
async function extractTarGz(
  tarGzPath: string,
  destDir: string,
  stripComponents: number = 1
): Promise<void> {
  // Create destination directory
  await fs.mkdir(destDir, { recursive: true });

  // Try using system tar command first (more reliable for large archives)
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Use execFile with array args to prevent shell injection
    await execFileAsync('tar', [
      '-xzf', tarGzPath,
      '-C', destDir,
      `--strip-components=${stripComponents}`
    ], { timeout: 120000 });

    logger.debug('Extracted using system tar', { tarGzPath, destDir });
    return;
  } catch (tarError) {
    logger.debug('System tar failed, falling back to custom parser', { error: tarError });
  }

  // Fallback to custom parser
  await extractTarGzCustom(tarGzPath, destDir, stripComponents);
}

/**
 * Custom tar.gz extractor for platforms without tar command
 */
async function extractTarGzCustom(
  tarGzPath: string,
  destDir: string,
  stripComponents: number = 1
): Promise<void> {
  // Read and decompress
  const compressedData = await fs.readFile(tarGzPath);
  const decompressed = await new Promise<Buffer>((resolve, reject) => {
    zlib.gunzip(compressedData, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

  // Parse tar format
  let offset = 0;
  while (offset < decompressed.length) {
    // Read tar header (512 bytes)
    const header = decompressed.subarray(offset, offset + 512);

    // Check for end of archive (two empty blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const name = parseString(header, 0, 100);
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);

    // Handle pax extended headers (type 'x' or 'g')
    let actualName = name;
    let actualSize = size;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // This is a pax extended header, parse it
      const paxData = decompressed.subarray(
        offset + 512,
        offset + 512 + Math.ceil(size / 512) * 512
      );
      const paxContent = paxData.subarray(0, size).toString('utf8');

      // Parse pax fields
      const pathMatch = paxContent.match(/\d+ path=(.+)\n/);
      if (pathMatch) {
        actualName = pathMatch[1];
      }

      const sizeMatch = paxContent.match(/\d+ size=(\d+)\n/);
      if (sizeMatch) {
        actualSize = parseInt(sizeMatch[1], 10);
      }

      // Skip to next entry
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    // Use UStar prefix if present
    const prefix = parseString(header, 345, 155);
    if (prefix) {
      actualName = prefix + '/' + actualName;
    }

    // Skip empty names
    if (!actualName) {
      offset += 512;
      continue;
    }

    // Strip leading components from path
    const pathParts = actualName.split('/').filter(Boolean);
    if (pathParts.length <= stripComponents) {
      // Skip entries that would be stripped entirely
      offset += 512 + Math.ceil(actualSize / 512) * 512;
      continue;
    }

    const strippedPath = pathParts.slice(stripComponents).join('/');
    const destPath = path.join(destDir, strippedPath);

    // Process based on type
    if (typeFlag === '5' || actualName.endsWith('/')) {
      // Directory
      await fs.mkdir(destPath, { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      // Regular file
      const fileData = decompressed.subarray(
        offset + 512,
        offset + 512 + actualSize
      );

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(destPath), { recursive: true });

      // Write file
      await fs.writeFile(destPath, fileData);

      // Set file mode
      if (mode > 0) {
        try {
          await fs.chmod(destPath, mode);
        } catch {
          // Ignore chmod errors on some platforms
        }
      }
    } else if (typeFlag === '2') {
      // Symbolic link
      const linkTarget = parseString(header, 157, 100);
      try {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.symlink(linkTarget, destPath);
      } catch {
        // Ignore symlink errors
      }
    }

    // Move to next entry (header + padded data)
    offset += 512 + Math.ceil(actualSize / 512) * 512;
  }
}

/**
 * Parse a null-terminated string from tar header
 */
function parseString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const nullIndex = slice.indexOf(0);
  return slice.subarray(0, nullIndex === -1 ? length : nullIndex).toString('utf8');
}

/**
 * Parse an octal number from tar header
 */
function parseOctal(buffer: Buffer, offset: number, length: number): number {
  const str = parseString(buffer, offset, length).trim();
  if (!str) return 0;

  // Handle GNU tar extended format (binary)
  if (buffer[offset] === 0x80) {
    // Binary format, not commonly used by GitHub
    return 0;
  }

  return parseInt(str, 8) || 0;
}

// ============================================================================
// Download Functions
// ============================================================================

/**
 * Download a GitHub repository to a local directory
 */
export async function downloadRepository(
  options: DownloadOptions
): Promise<DownloadResult> {
  const { owner, repo, branch, targetDir, skillsPath } = options;
  const localPath = skillsPath
    ? path.join(targetDir, skillsPath)
    : targetDir;

  logger.info('Downloading repository', { owner, repo, branch, targetDir });

  // Create temp directory for download
  const tempDir = path.join(targetDir, '.download-temp-' + Date.now());
  const tarGzPath = path.join(tempDir, 'repo.tar.gz');

  try {
    // Ensure target directory exists
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    // Get latest commit hash first
    const commitHash = await getLatestCommit(owner, repo, branch);
    if (!commitHash) {
      return {
        success: false,
        localPath,
        error: `Could not find repository ${owner}/${repo} or branch ${branch}`,
      };
    }

    // Download tarball with retry
    const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.debug('Downloading tarball', { url: tarballUrl, attempt });

        const response = await axios.get(tarballUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Code-Agent/1.0',
            ...(process.env.GITHUB_TOKEN
              ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
              : {}),
          },
          httpsAgent,
          timeout: 120000, // 2 minute timeout for large repos
          maxContentLength: 100 * 1024 * 1024, // 100MB max
        });

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Write to temp file
        await fs.writeFile(tarGzPath, response.data);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('Download attempt failed', {
          attempt,
          error: lastError.message,
        });

        if (attempt < 3) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, attempt - 1))
          );
        }
      }
    }

    if (lastError) {
      return {
        success: false,
        localPath,
        error: `Download failed after 3 attempts: ${lastError.message}`,
      };
    }

    // Remove existing target if it exists
    try {
      await fs.rm(localPath, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Extract tarball
    logger.debug('Extracting tarball', { tarGzPath, localPath });
    await extractTarGz(tarGzPath, localPath, 1);

    // Save metadata
    const meta: RepoMeta = {
      owner,
      repo,
      branch,
      commitHash,
      downloadedAt: Date.now(),
      lastUpdated: Date.now(),
    };
    await saveRepoMeta(localPath, meta);

    logger.info('Repository downloaded successfully', {
      owner,
      repo,
      branch,
      commitHash: commitHash.substring(0, 7),
      localPath,
    });

    return {
      success: true,
      localPath,
      commitHash,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download repository', {
      owner,
      repo,
      branch,
      error: errorMessage,
    });

    return {
      success: false,
      localPath,
      error: errorMessage,
    };
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// Update Functions
// ============================================================================

/**
 * Check if a local repository has updates available
 */
export async function checkForUpdates(
  localPath: string
): Promise<{ hasUpdate: boolean; latestCommit?: string }> {
  const meta = readRepoMeta(localPath);
  if (!meta) {
    return { hasUpdate: false };
  }

  const latestCommit = await getLatestCommit(meta.owner, meta.repo, meta.branch);
  if (!latestCommit) {
    return { hasUpdate: false };
  }

  return {
    hasUpdate: latestCommit !== meta.commitHash,
    latestCommit,
  };
}

/**
 * Update a local repository by re-downloading
 */
export async function updateRepository(
  localPath: string
): Promise<DownloadResult> {
  const meta = readRepoMeta(localPath);
  if (!meta) {
    return {
      success: false,
      localPath,
      error: 'No repository metadata found. Cannot determine remote source.',
    };
  }

  // Get parent directory
  const parentDir = path.dirname(localPath);
  const dirName = path.basename(localPath);

  // Backup existing directory
  const backupPath = path.join(parentDir, `${dirName}.backup-${Date.now()}`);

  try {
    await fs.rename(localPath, backupPath);
  } catch (error) {
    logger.warn('Could not create backup', { error });
  }

  // Download fresh copy
  const result = await downloadRepository({
    owner: meta.owner,
    repo: meta.repo,
    branch: meta.branch,
    targetDir: parentDir,
    skillsPath: dirName,
  });

  // Clean up backup on success, restore on failure
  if (result.success) {
    try {
      await fs.rm(backupPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  } else {
    // Restore backup
    try {
      await fs.rm(localPath, { recursive: true, force: true });
      await fs.rename(backupPath, localPath);
    } catch (restoreError) {
      logger.error('Failed to restore backup', { restoreError });
    }
  }

  return result;
}

// ============================================================================
// Metadata Functions
// ============================================================================

const META_FILENAME = '.meta.json';

/**
 * Read repository metadata from local path
 */
export function readRepoMeta(localPath: string): RepoMeta | null {
  try {
    const metaPath = path.join(localPath, META_FILENAME);
    // Use sync read for simplicity - this is called rarely
    const fs_sync = require('fs');
    const content = fs_sync.readFileSync(metaPath, 'utf8');
    return JSON.parse(content) as RepoMeta;
  } catch {
    return null;
  }
}

/**
 * Save repository metadata to local path
 */
export async function saveRepoMeta(
  localPath: string,
  meta: RepoMeta
): Promise<void> {
  const metaPath = path.join(localPath, META_FILENAME);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Read repository metadata asynchronously
 */
export async function readRepoMetaAsync(
  localPath: string
): Promise<RepoMeta | null> {
  try {
    const metaPath = path.join(localPath, META_FILENAME);
    const content = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(content) as RepoMeta;
  } catch {
    return null;
  }
}
