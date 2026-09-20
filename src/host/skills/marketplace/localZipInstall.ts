import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import type { InstallResult, PluginEntry } from './types';
import * as yaml from 'yaml';
import {
  extractZipSafely,
  getArchiveSha256,
  isZipExtractLimitError,
  MAX_GITHUB_ARCHIVE_BYTES,
} from './githubArchiveSecurity';
import { runExclusivePluginInstall, throwIfInstallAborted } from './installConcurrency';
import { loadInstalledPlugins, performInstall } from './installService';

const LOCAL_ZIP_MARKETPLACE = 'local-zip';
const SKILL_ZIP_MISSING_SKILL_MD = 'SKILL_ZIP_MISSING_SKILL_MD';
const SKILL_ZIP_MULTIPLE_SKILL_MD = 'SKILL_ZIP_MULTIPLE_SKILL_MD';
const SKILL_ZIP_TOO_LARGE = 'SKILL_ZIP_TOO_LARGE';
const SKILL_ZIP_INVALID_SHAPE = 'SKILL_ZIP_INVALID_SHAPE';
const SKILL_ZIP_INVALID_FRONTMATTER = 'SKILL_ZIP_INVALID_FRONTMATTER';

function parseRequiredSkillFrontmatter(content: string): { name: string; description: string } {
  const fence = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) {
    throw new Error(`${SKILL_ZIP_INVALID_FRONTMATTER}: missing YAML frontmatter`);
  }
  const parsed = yaml.parse(fence[1]) as { name?: unknown; description?: unknown } | null;
  const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  const description = typeof parsed?.description === 'string' ? parsed.description.trim() : '';
  if (!name || !description) {
    throw new Error(`${SKILL_ZIP_INVALID_FRONTMATTER}: name and description are required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`${SKILL_ZIP_INVALID_FRONTMATTER}: invalid skill name`);
  }
  return { name, description };
}

async function listSkillMarkdownRelPaths(rootDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`SKILL_ZIP_UNSAFE_ENTRY: symbolic link rejected (${path.relative(rootDir, fullPath)})`);
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (stat.isFile() && entry.name === 'SKILL.md') {
        found.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
      }
    }
  }

  await walk(rootDir);
  return found;
}

async function resolveLocalZipSkillDir(extractRoot: string): Promise<string> {
  const skillMarkdowns = await listSkillMarkdownRelPaths(extractRoot);
  if (skillMarkdowns.length === 0) {
    throw new Error(`${SKILL_ZIP_MISSING_SKILL_MD}: zip has no SKILL.md`);
  }
  if (skillMarkdowns.length > 1) {
    throw new Error(`${SKILL_ZIP_MULTIPLE_SKILL_MD}: ${skillMarkdowns.join(', ')}`);
  }
  const [relative] = skillMarkdowns;
  if (!relative) {
    throw new Error(`${SKILL_ZIP_MISSING_SKILL_MD}: zip has no SKILL.md`);
  }
  const dirRelative = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  if (dirRelative) return dirRelative;

  const content = await fs.readFile(path.join(extractRoot, 'SKILL.md'), 'utf8');
  const skillName = parseRequiredSkillFrontmatter(content).name;
  const destination = path.join(extractRoot, skillName);
  if (fsSync.existsSync(destination)) {
    throw new Error(`${SKILL_ZIP_INVALID_SHAPE}: cannot nest root SKILL.md under existing ${skillName}`);
  }
  await fs.mkdir(destination);
  const entries = await fs.readdir(extractRoot);
  for (const name of entries) {
    if (name === skillName || name === '_meta.json') continue;
    await fs.rename(path.join(extractRoot, name), path.join(destination, name));
  }
  return skillName;
}

async function installFromLocalZipUnlocked(
  archive: Buffer,
  options: { force?: boolean; enableAfterInstall?: boolean; signal?: AbortSignal },
): Promise<InstallResult> {
  throwIfInstallAborted(options.signal);
  if (archive.byteLength === 0) {
    throw new Error(`${SKILL_ZIP_INVALID_SHAPE}: empty zip`);
  }
  if (archive.byteLength > MAX_GITHUB_ARCHIVE_BYTES) {
    throw new Error(
      `${SKILL_ZIP_TOO_LARGE}: exceeds ${Math.floor(MAX_GITHUB_ARCHIVE_BYTES / 1024 / 1024)} MB`,
    );
  }

  const tempDir = path.join(
    getUserConfigDir(),
    'marketplace-plugin-cache',
    `tmp-local-zip-${randomUUID()}`,
  );
  try {
    try {
      await extractZipSafely(archive, tempDir, options.signal);
    } catch (error) {
      if (isZipExtractLimitError(error)) {
        throw new Error(
          `${SKILL_ZIP_TOO_LARGE}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    throwIfInstallAborted(options.signal);
    const skillDirName = await resolveLocalZipSkillDir(tempDir);
    const skillMarkdown = await fs.readFile(path.join(tempDir, skillDirName, 'SKILL.md'), 'utf8');
    parseRequiredSkillFrontmatter(skillMarkdown);
    const pluginSpec = `${skillDirName}@${LOCAL_ZIP_MARKETPLACE}`;
    const state = await loadInstalledPlugins();
    throwIfInstallAborted(options.signal);
    const existing = state[pluginSpec];
    if (existing && !options.force) {
      throw new Error(`Plugin '${pluginSpec}' is already installed. Use --force to reinstall.`);
    }
    const entry: PluginEntry = {
      name: skillDirName,
      source: './',
      skills: [skillDirName],
    };
    return await performInstall({
      plugin: skillDirName,
      marketplace: LOCAL_ZIP_MARKETPLACE,
      pluginSpec,
      entry,
      sourceTrust: 'local-marketplace',
      entrySource: {
        sourceBase: tempDir,
        contentHash: getArchiveSha256(archive),
      },
      scope: 'user',
      state,
      existing,
      force: options.force,
      enableAfterInstall: options.enableAfterInstall !== false,
      signal: options.signal,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 从本机 SKILL.md ZIP 安装。解压走 extractZipSafely，落盘前走 performInstall
 * 里的 scanInstallContent，不另开第三条安装链。
 */
export function installFromLocalZip(
  archive: Buffer,
  options: { force?: boolean; enableAfterInstall?: boolean; signal?: AbortSignal } = {},
): Promise<InstallResult> {
  return runExclusivePluginInstall(
    LOCAL_ZIP_MARKETPLACE,
    () => installFromLocalZipUnlocked(archive, options),
  );
}
