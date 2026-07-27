// ============================================================================
// Git Downloader - Download GitHub repositories without git CLI
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { SkillRepoSourceType } from '../../../shared/contract/skillRepository';
import { createLogger } from '../infra/logger';

const logger = createLogger('GitDownloader');
const execFileAsync = promisify(execFile);

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

interface GitHubRepoInfo {
  source: 'github';
  owner: string;
  repo: string;
  branch: string;
}

interface ModelScopeRepoInfo {
  source: 'modelscope';
  owner: string;
  repo: string;
  branch: string;
  repoType: 'model' | 'skill';
}

type RepoInfo = GitHubRepoInfo | ModelScopeRepoInfo;

export interface DownloadOptions {
  source?: SkillRepoSourceType;
  owner: string;
  repo: string;
  branch: string;
  targetDir: string;
  skillsPath?: string;
  modelScopeRepoType?: 'model' | 'skill';
}

export interface DownloadResult {
  success: boolean;
  localPath: string;
  commitHash?: string;
  error?: string;
}

export interface RepoMeta {
  source: SkillRepoSourceType;
  owner: string;
  repo: string;
  branch: string;
  commitHash: string;
  downloadedAt: number;
  lastUpdated: number;
  skillsPath?: string;
  modelScopeRepoType?: 'model' | 'skill';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRepoMeta(value: unknown): RepoMeta | null {
  if (!isRecord(value)) return null;

  const {
    source,
    owner,
    repo,
    branch,
    commitHash,
    downloadedAt,
    lastUpdated,
    skillsPath,
    modelScopeRepoType,
  } = value;
  if (
    (source !== undefined && source !== 'github' && source !== 'modelscope') ||
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof branch !== 'string' ||
    typeof commitHash !== 'string' ||
    typeof downloadedAt !== 'number' ||
    typeof lastUpdated !== 'number' ||
    (skillsPath !== undefined && typeof skillsPath !== 'string') ||
    (modelScopeRepoType !== undefined &&
      modelScopeRepoType !== 'model' &&
      modelScopeRepoType !== 'skill')
  ) {
    return null;
  }

  return {
    // Metadata written before multi-source support was GitHub-only.
    source: source === 'modelscope' ? 'modelscope' : 'github',
    owner,
    repo,
    branch,
    commitHash,
    downloadedAt,
    lastUpdated,
    ...(skillsPath ? { skillsPath } : {}),
    ...(modelScopeRepoType ? { modelScopeRepoType } : {}),
  };
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
function parseGitHubUrl(url: string): GitHubRepoInfo | null {
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
    const branch = match[3] || 'main';
    if (
      !isSafeRepoSegment(match[1]) ||
      !isSafeRepoSegment(match[2]) ||
      !isSafeRepoSegment(branch)
    ) {
      return null;
    }
    return {
      source: 'github',
      owner: match[1],
      repo: match[2],
      branch,
    };
  }

  match = url.match(shortPattern);
  if (match) {
    if (!isSafeRepoSegment(match[1]) || !isSafeRepoSegment(match[2])) {
      return null;
    }
    return {
      source: 'github',
      owner: match[1],
      repo: match[2],
      branch: 'main',
    };
  }

  return null;
}

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

function isSafeRepoSegment(value: string): boolean {
  return REPO_SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..';
}

/**
 * Parse a supported skill repository URL.
 *
 * ModelScope URL forms verified against live public repositories on 2026-07-27:
 * - https://www.modelscope.cn/ms-agent/skill_examples
 * - https://www.modelscope.cn/models/ms-agent/skill_examples
 * - https://www.modelscope.cn/skills/@halcyon666/write-skills
 *
 * Model pages map to the regular `<namespace>/<name>.git` endpoint. Skill
 * pages currently reject that clone URL and are downloaded through the
 * `/api/v1/skills/@<namespace>/<name>/archive/zip/<revision>` fallback.
 */
export function parseRepoUrl(url: string): RepoInfo | null {
  const github = parseGitHubUrl(url);
  if (github) {
    return github;
  }

  if (!url || typeof url !== 'string') {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.port ||
    !/^(?:www\.)?modelscope\.cn$/i.test(parsedUrl.hostname)
  ) {
    return null;
  }

  let segments: string[];
  try {
    segments = parsedUrl.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  let repoType: ModelScopeRepoInfo['repoType'] = 'model';
  if (segments[0]?.toLowerCase() === 'skills') {
    repoType = 'skill';
    segments = segments.slice(1);
  } else if (segments[0]?.toLowerCase() === 'models') {
    segments = segments.slice(1);
  }

  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0].replace(/^@/, '');
  const repo = segments[1].replace(/\.git$/i, '');
  const allowedSuffixes = new Set(['summary', 'files', 'skills']);
  if (
    !isSafeRepoSegment(owner) ||
    !isSafeRepoSegment(repo) ||
    (segments.length > 2 && !segments.slice(2).every((segment) => allowedSuffixes.has(segment)))
  ) {
    return null;
  }

  return {
    source: 'modelscope',
    owner,
    repo,
    branch: 'master',
    repoType,
  };
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
    const response = await axios.get<unknown>(url, {
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

    const data = response.data;
    if (isRecord(data) && typeof data.sha === 'string') {
      return data.sha;
    }

    logger.warn('GitHub API response missing commit sha', { owner, repo, branch });
    return null;
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
    const actualSize = size;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // The fallback extractor skips the metadata entry and processes the next
      // tar header as-is, matching the existing behavior of this parser.
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

function getModelScopeCloneUrl(owner: string, repo: string): string {
  return `https://www.modelscope.cn/${owner}/${repo}.git`;
}

function getModelScopeApiSegment(repoType: 'model' | 'skill'): string {
  return repoType === 'skill' ? 'skills' : 'models';
}

function getModelScopeApiOwner(owner: string, repoType: 'model' | 'skill'): string {
  return repoType === 'skill' ? `@${owner}` : owner;
}

async function getModelScopeLatestCommit(
  owner: string,
  repo: string,
  branch: string,
  repoType: 'model' | 'skill'
): Promise<string | null> {
  const cloneUrl = getModelScopeCloneUrl(owner, repo);
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', cloneUrl, 'HEAD'], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const commitHash = stdout.trim().split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/i.test(commitHash)) {
      return commitHash;
    }
  } catch (error) {
    logger.debug('ModelScope ls-remote failed; trying repository API', {
      cloneUrl,
      error,
    });
  }

  const segment = getModelScopeApiSegment(repoType);
  const apiOwner = getModelScopeApiOwner(owner, repoType);
  const filesUrl =
    `https://www.modelscope.cn/api/v1/${segment}/` +
    `${encodeURIComponent(apiOwner)}/${encodeURIComponent(repo)}/repo/files`;

  try {
    const response = await axios.get<unknown>(filesUrl, {
      params: {
        Revision: branch,
        Recursive: 'true',
      },
      headers: { 'User-Agent': 'Code-Agent/1.0' },
      httpsAgent,
      timeout: 30000,
    });
    const data = isRecord(response.data) && isRecord(response.data.Data)
      ? response.data.Data
      : null;
    const latestCommitter = data && isRecord(data.LatestCommitter)
      ? data.LatestCommitter
      : null;
    const webUrl = latestCommitter?.WebURL;
    const commitMatch = typeof webUrl === 'string'
      ? webUrl.match(/\/commit\/([0-9a-f]{40})(?:\/|$)/i)
      : null;
    if (commitMatch) {
      return commitMatch[1];
    }

    const files = data?.Files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (isRecord(file) && typeof file.Revision === 'string' &&
            /^[0-9a-f]{40}$/i.test(file.Revision)) {
          return file.Revision;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to resolve ModelScope repository revision', {
      owner,
      repo,
      branch,
      repoType,
      error,
    });
  }

  return null;
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  try {
    await execFileAsync('unzip', ['-q', archivePath, '-d', destination], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  } catch (unzipError) {
    logger.debug('unzip failed; trying tar archive extraction', { unzipError });
  }

  await execFileAsync('tar', ['-xf', archivePath, '-C', destination], {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function moveExtractedRepository(extractedDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(extractedDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => entry.name !== '__MACOSX');
  const sourceDir = visibleEntries.length === 1 && visibleEntries[0].isDirectory()
    ? path.join(extractedDir, visibleEntries[0].name)
    : extractedDir;

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.rename(sourceDir, targetDir);
}

async function downloadModelScopeRepository(
  options: DownloadOptions,
  tempDir: string
): Promise<{ commitHash: string; cloneError?: string }> {
  const {
    owner,
    repo,
    branch,
    targetDir,
    modelScopeRepoType = 'model',
  } = options;
  const cloneUrl = getModelScopeCloneUrl(owner, repo);
  const cloneDir = path.join(tempDir, 'clone');
  let cloneError: string | undefined;

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--branch', branch, cloneUrl, cloneDir],
      {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    const { stdout } = await execFileAsync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const commitHash = stdout.trim();
    await fs.rm(path.join(cloneDir, '.git'), { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(cloneDir, targetDir);
    return { commitHash };
  } catch (error) {
    cloneError = error instanceof Error ? error.message : String(error);
    logger.warn('ModelScope git clone failed; trying archive API', {
      cloneUrl,
      error: cloneError,
    });
    await fs.rm(cloneDir, { recursive: true, force: true });
  }

  const commitHash = await getModelScopeLatestCommit(
    owner,
    repo,
    branch,
    modelScopeRepoType
  );
  if (!commitHash) {
    throw new Error(
      `ModelScope clone failed (${cloneError}) and archive revision could not be resolved`
    );
  }

  const segment = getModelScopeApiSegment(modelScopeRepoType);
  const apiOwner = getModelScopeApiOwner(owner, modelScopeRepoType);
  const archiveUrl =
    `https://www.modelscope.cn/api/v1/${segment}/` +
    `${encodeURIComponent(apiOwner)}/${encodeURIComponent(repo)}/archive/zip/` +
    encodeURIComponent(branch);
  const archivePath = path.join(tempDir, 'repo.zip');
  const extractedDir = path.join(tempDir, 'extracted');

  try {
    const response = await axios.get<ArrayBuffer>(archiveUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Code-Agent/1.0' },
      httpsAgent,
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024,
    });
    await fs.writeFile(archivePath, Buffer.from(response.data));
    await extractZipArchive(archivePath, extractedDir);
    await moveExtractedRepository(extractedDir, targetDir);
    return { commitHash, cloneError };
  } catch (error) {
    const archiveError = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ModelScope clone failed (${cloneError}); archive download failed (${archiveError})`,
      { cause: error }
    );
  }
}

/** Download a supported repository to a local directory. */
export async function downloadRepository(
  options: DownloadOptions
): Promise<DownloadResult> {
  const {
    source = 'github',
    owner,
    repo,
    branch,
    targetDir,
    skillsPath,
    modelScopeRepoType,
  } = options;
  const localPath = skillsPath
    ? path.join(targetDir, skillsPath)
    : targetDir;

  logger.info('Downloading repository', { source, owner, repo, branch, targetDir });

  // Keep temporary content beside the target so replacing the target cannot
  // delete an in-progress download.
  const tempDir = path.join(
    path.dirname(targetDir),
    `.${path.basename(targetDir)}.download-temp-${Date.now()}`
  );
  const tarGzPath = path.join(tempDir, 'repo.tar.gz');

  try {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    let commitHash: string;

    if (source === 'modelscope') {
      const result = await downloadModelScopeRepository(options, tempDir);
      commitHash = result.commitHash;
    } else {
      const latestCommit = await getLatestCommit(owner, repo, branch);
      if (!latestCommit) {
        return {
          success: false,
          localPath,
          error: `Could not find repository ${owner}/${repo} or branch ${branch}`,
        };
      }
      commitHash = latestCommit;

      const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          logger.debug('Downloading tarball', { url: tarballUrl, attempt });

          const response = await axios.get<ArrayBuffer>(tarballUrl, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Code-Agent/1.0',
              ...(process.env.GITHUB_TOKEN
                ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
                : {}),
            },
            httpsAgent,
            timeout: 120000,
            maxContentLength: 100 * 1024 * 1024,
          });

          await fs.writeFile(tarGzPath, Buffer.from(response.data));
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn('Download attempt failed', {
            attempt,
            error: lastError.message,
          });

          if (attempt < 3) {
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

      await fs.rm(localPath, { recursive: true, force: true });
      logger.debug('Extracting tarball', { tarGzPath, localPath });
      await extractTarGz(tarGzPath, localPath, 1);
    }

    const meta: RepoMeta = {
      source,
      owner,
      repo,
      branch,
      commitHash,
      downloadedAt: Date.now(),
      lastUpdated: Date.now(),
      ...(skillsPath ? { skillsPath } : {}),
      ...(modelScopeRepoType ? { modelScopeRepoType } : {}),
    };
    await saveRepoMeta(localPath, meta);

    logger.info('Repository downloaded successfully', {
      source,
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
      source,
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

  const latestCommit = meta.source === 'modelscope'
    ? await getModelScopeLatestCommit(
      meta.owner,
      meta.repo,
      meta.branch,
      meta.modelScopeRepoType || 'model'
    )
    : await getLatestCommit(meta.owner, meta.repo, meta.branch);
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
    source: meta.source,
    owner: meta.owner,
    repo: meta.repo,
    branch: meta.branch,
    targetDir: localPath,
    modelScopeRepoType: meta.modelScopeRepoType,
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
    const content = readFileSync(metaPath, 'utf8');
    return parseRepoMeta(JSON.parse(content) as unknown);
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
    return parseRepoMeta(JSON.parse(content) as unknown);
  } catch {
    return null;
  }
}
