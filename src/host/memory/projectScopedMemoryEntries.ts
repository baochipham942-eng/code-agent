// ============================================================================
// Project Scoped Memory Entries — 设置 > 记忆页的项目层记忆 overlay（FB-413）
// ============================================================================
//
// 缺陷：MemoryWrite scope=project 写入 projects/<key>/memory/memories/*.md 后，
// 设置 > 记忆页（handleListMemoryEntries 路径）看不到这些条目（页面总数 0）。
// 本模块只服务该页的 list/update/delete：
// - list：扫描 projects/<key>/memory/memories/，构建 id=project:<key>:<filename> 的条目
// - update：在原文件内改写 name/description/正文/status（保留其余 frontmatter 行）
// - delete：软归档（status: archived + 移出该层 MEMORY.md 索引），语义同 roleAssetService
//
// 红线：listUnifiedMemoryEntries / packMemoryEntries / 导入导出 / 镜像重建一概不动 ——
// 项目记忆已由 loadScopedMemoryIndex 注入，混进共享列表会双重注入并污染导出。

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  MemoryEntry,
  MemoryEntryDeleteRequest,
  MemoryEntryDeleteResult,
  MemoryEntryListResult,
  MemoryEntryStatus,
  MemoryEntryUpdateRequest,
  MemoryEntryUpdateResult,
} from '../../shared/contract/memory';
import { ROLE_ASSETS } from '../../shared/constants';
import { getProjectsRootDir } from '../services/roleAssets/roleAssetPaths';
import {
  removeFromScopedIndex,
  sanitizeMemoryFilename,
  updateScopedIndex,
} from '../services/roleAssets/roleAssetService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProjectScopedMemoryEntries');

const ENTRY_ID_PREFIX = 'project:';
const ENTRY_STATUSES = new Set<MemoryEntryStatus>(['candidate', 'active', 'rejected', 'stale', 'archived']);

/** projects/<key>/ 下的记忆段名，与 roleAssetPaths.getProjectMemoryDir 一致 */
const PROJECT_MEMORY_SEGMENT = 'memory';

export function isProjectScopedEntryId(entryId: string): boolean {
  return entryId.startsWith(ENTRY_ID_PREFIX);
}

interface ProjectEntryRef {
  projectKey: string;
  filename: string;
}

function isSafeDirName(name: string): boolean {
  if (!name.trim()) return false;
  if (name !== path.basename(name)) return false;
  if (name === '.' || name === '..') return false;
  return !/[/\\\0]/.test(name);
}

/** 解析页面条目 id（project:<projectKey>:<filename>）；key/filename 都必须是纯 basename，防路径穿越。 */
function parseProjectEntryId(entryId: string): ProjectEntryRef | null {
  const parts = entryId.split(':');
  if (parts.length !== 3 || parts[0] !== 'project') return null;
  const projectKey = parts[1];
  if (!isSafeDirName(projectKey)) return null;
  try {
    return { projectKey, filename: sanitizeMemoryFilename(parts[2]) };
  } catch {
    return null;
  }
}

function projectMemoriesDirFor(projectKey: string): string {
  return path.join(getProjectsRootDir(), projectKey, PROJECT_MEMORY_SEGMENT, ROLE_ASSETS.MEMORIES_SUBDIR);
}

function projectMetaPathFor(projectKey: string): string {
  return path.join(getProjectsRootDir(), projectKey, ROLE_ASSETS.META_FILENAME);
}

function projectIndexPathFor(projectKey: string): string {
  return path.join(getProjectsRootDir(), projectKey, PROJECT_MEMORY_SEGMENT, ROLE_ASSETS.INDEX_FILENAME);
}

/** 展示路径：home 下折成 ~/...（与 sandbox/probe.displayPath 同式） */
function displayPath(filePath: string, homeDir: string = os.homedir()): string {
  const resolvedHome = path.resolve(homeDir);
  if (filePath === resolvedHome || filePath.startsWith(`${resolvedHome}${path.sep}`)) {
    return `~${filePath.slice(resolvedHome.length)}`;
  }
  return filePath;
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

interface ParsedMemoryFile {
  /** frontmatter 内的原始行（不含 --- 围栏），改写时原样保留 */
  frontmatterLines: string[];
  name?: string;
  description?: string;
  status?: string;
  created?: string;
  body: string;
}

function parseMemoryFile(content: string): ParsedMemoryFile {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatterLines: [], body: content.trim() };
  const lines = match[1].split('\n');
  const fm: Record<string, string> = {};
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return {
    frontmatterLines: lines,
    name: fm.name,
    description: fm.description,
    status: fm.status,
    created: fm.created,
    body: match[2].trim(),
  };
}

function normalizeStatus(raw: string | undefined): MemoryEntryStatus {
  return raw && ENTRY_STATUSES.has(raw as MemoryEntryStatus) ? raw as MemoryEntryStatus : 'active';
}

function projectMemoryFileToEntry(
  projectKey: string,
  filename: string,
  content: string,
  mtimeMs: number,
  workspacePath: string | null,
): MemoryEntry {
  const parsed = parseMemoryFile(content);
  const body = parsed.body;
  const createdAt = (parsed.created ? Date.parse(parsed.created) : Number.NaN) || mtimeMs;
  return {
    id: `${ENTRY_ID_PREFIX}${projectKey}:${filename}`,
    schemaVersion: 2,
    status: normalizeStatus(parsed.status),
    deprecatedBy: null,
    kind: 'project',
    scope: 'project',
    title: parsed.name || filename.replace(/\.md$/, ''),
    summary: parsed.description || compactText(body, 160),
    content: body,
    source: {
      kind: 'light_file',
      sourceOfTruth: 'light_file',
      filePath: filename,
      label: displayPath(path.join(projectMemoriesDirFor(projectKey), filename)),
    },
    evidence: [{ filePath: filename, source: 'project-memory' }],
    projectPath: workspacePath,
    sessionId: null,
    confidence: 1,
    createdAt,
    updatedAt: mtimeMs,
  };
}

/** projects/<key>/meta.json 的 workspacePath（缺失/损坏返回 null，不连累列表） */
async function readProjectWorkspacePath(projectKey: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await fs.readFile(projectMetaPathFor(projectKey), 'utf-8')) as { workspacePath?: unknown };
    return typeof meta.workspacePath === 'string' && meta.workspacePath.trim() ? meta.workspacePath : null;
  } catch {
    return null;
  }
}

/** 列出所有项目的记忆条目（overlay 内部用；读不出的单文件跳过并 warn 原因）。 */
async function listProjectScopedMemoryEntries(): Promise<MemoryEntry[]> {
  const projectsRoot = getProjectsRootDir();
  let projectDirs: Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return []; // projects 根目录还不存在（没有任何项目记忆）
  }

  const entries: MemoryEntry[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const memoriesDir = path.join(projectsRoot, dir.name, PROJECT_MEMORY_SEGMENT, ROLE_ASSETS.MEMORIES_SUBDIR);
    let filenames: string[];
    try {
      filenames = (await fs.readdir(memoriesDir)).filter((name) => name.endsWith('.md'));
    } catch {
      continue; // 该项目没有 memories 目录
    }
    const workspacePath = await readProjectWorkspacePath(dir.name);
    for (const filename of filenames) {
      const filePath = path.join(memoriesDir, filename);
      try {
        const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
        entries.push(projectMemoryFileToEntry(dir.name, filename, content, stat.mtimeMs, workspacePath));
      } catch (error) {
        logger.warn('Failed to read project memory file', {
          projectKey: dir.name,
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 把项目层条目 overlay 进页面列表结果：追加 + 计入 light_file + 维持 updatedAt 倒序。 */
export async function overlayProjectScopedEntries(result: MemoryEntryListResult): Promise<MemoryEntryListResult> {
  const projectEntries = await listProjectScopedMemoryEntries();
  if (projectEntries.length === 0) return result;
  return {
    entries: [...result.entries, ...projectEntries].sort((a, b) => b.updatedAt - a.updatedAt),
    sourceCounts: {
      ...result.sourceCounts,
      light_file: (result.sourceCounts.light_file || 0) + projectEntries.length,
    },
  };
}

function setFrontmatterLine(lines: string[], key: string, value: string): string[] {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  const next = [...lines];
  if (index >= 0) next[index] = `${key}: ${value}`;
  else next.push(`${key}: ${value}`);
  return next;
}

function serializeMemoryFile(frontmatterLines: string[], body: string): string {
  return `---\n${frontmatterLines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/**
 * 页面路径的更新：只改写 name/description/正文/status，其余 frontmatter 行原样保留。
 * projectPath / kind / scope 编辑忽略（文件格式承载不了，项目归属由目录决定）。
 */
export async function updateProjectScopedMemoryEntry(request: MemoryEntryUpdateRequest): Promise<MemoryEntryUpdateResult> {
  const ref = parseProjectEntryId(request.entryId);
  if (!ref) throw new Error(`Invalid project memory entry id: ${request.entryId}`);
  const filePath = path.join(projectMemoriesDirFor(ref.projectKey), ref.filename);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Project memory file not found: ${displayPath(filePath)}`);
  }
  const parsed = parseMemoryFile(content);

  const nextName = request.title?.trim() || parsed.name || ref.filename.replace(/\.md$/, '');
  const nextDescription = request.summary?.trim() ?? parsed.description ?? '';
  const nextBody = request.content !== undefined ? request.content : parsed.body;
  const nextStatus = request.status !== undefined && ENTRY_STATUSES.has(request.status)
    ? request.status
    : normalizeStatus(parsed.status);

  let lines = parsed.frontmatterLines;
  lines = setFrontmatterLine(lines, 'name', nextName);
  lines = setFrontmatterLine(lines, 'description', nextDescription);
  if (request.status !== undefined || parsed.status !== undefined) {
    lines = setFrontmatterLine(lines, 'status', nextStatus);
  }
  await fs.writeFile(filePath, serializeMemoryFile(lines, nextBody), 'utf-8');

  // 索引对账：active 才留在注入索引里（与 writeScopedMemory / archiveScopedMemory 同语义）
  if (nextStatus === 'active') {
    await updateScopedIndex(projectIndexPathFor(ref.projectKey), ref.filename, nextDescription);
  } else {
    await removeFromScopedIndex(projectIndexPathFor(ref.projectKey), ref.filename);
  }
  logger.info('Project memory updated from settings page', { projectKey: ref.projectKey, filename: ref.filename });

  const [updatedContent, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
  const workspacePath = await readProjectWorkspacePath(ref.projectKey);
  return {
    entry: projectMemoryFileToEntry(ref.projectKey, ref.filename, updatedContent, stat.mtimeMs, workspacePath),
  };
}

/** 页面路径的删除：软归档（status: archived + 移出索引），文件与正文保留。 */
export async function deleteProjectScopedMemoryEntry(request: MemoryEntryDeleteRequest): Promise<MemoryEntryDeleteResult> {
  const ref = parseProjectEntryId(request.entryId);
  if (!ref) throw new Error(`Invalid project memory entry id: ${request.entryId}`);
  const filePath = path.join(projectMemoriesDirFor(ref.projectKey), ref.filename);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    await removeFromScopedIndex(projectIndexPathFor(ref.projectKey), ref.filename);
    return { deleted: false, sourceOfTruth: 'light_file' };
  }

  const archived = rewriteStatusArchived(content);
  await fs.writeFile(filePath, archived, 'utf-8');
  await removeFromScopedIndex(projectIndexPathFor(ref.projectKey), ref.filename);
  logger.info('Project memory archived from settings page', { projectKey: ref.projectKey, filename: ref.filename });
  return { deleted: true, sourceOfTruth: 'light_file' };
}

/** 与 roleAssetService.archiveScopedMemory 同款改写，另兜底没有 frontmatter 围栏的文件 */
function rewriteStatusArchived(content: string): string {
  if (/^status:\s*\S+\s*$/m.test(content)) {
    return content.replace(/^status:\s*\S+\s*$/m, 'status: archived');
  }
  if (/^---\s*$/m.test(content)) {
    return content.replace(/^---\s*$/m, '---\nstatus: archived');
  }
  return `---\nstatus: archived\n---\n\n${content}`;
}
