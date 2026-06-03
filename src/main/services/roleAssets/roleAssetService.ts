// ============================================================================
// Role Asset Service — 持久化角色资产核心服务
// ============================================================================
//
// 核心论点（docs/designs/persistent-role-assets.md）：
//   持久的是资产（角色定义 + 记忆 + 履历），瞬时的是实例。
//   角色和记忆是户口，实例是上班。
//
// 职责：
// - 角色绑定检测：roles/<roleId>/ 目录存在 → 持久角色（约定优于配置，agent 定义零改动）
// - 三层记忆读写：角色记忆 / 项目记忆（全局记忆由现有 Light Memory 负责，不动）
// - 注入块构建：实例化时把角色记忆索引 + 项目记忆索引 + 最近履历拼进 system prompt
// - 履历写入：产物清单（不记任务记产物，设计 §4.3）
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../infra/logger';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';
import { ROLE_ASSETS } from '../../../shared/constants';
import {
  getRoleDir,
  getRoleMemoriesDir,
  getRoleMemoryIndexPath,
  getRoleHistoryPath,
  getRolesRootDir,
  getProjectDir,
  getProjectMemoriesDir,
  getProjectMemoryIndexPath,
  getProjectMetaPath,
  isSafeRoleId,
} from './roleAssetPaths';

const logger = createLogger('RoleAssets');

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 记忆写入的目标层（全局层复用现有 Light Memory，路由在 roleWriteBack 做） */
export type RoleMemoryScope = 'role' | 'project';

export interface RoleMemoryEntry {
  /** 文件名（kebab-case，.md 结尾） */
  filename: string;
  /** 记忆名（frontmatter） */
  name: string;
  /** 一句话描述（索引/检索用） */
  description: string;
  /** 记忆正文 */
  content: string;
}

export interface RoleMemoryFile extends RoleMemoryEntry {
  /** 所属层 */
  scope: RoleMemoryScope;
  /** 最后修改时间（ISO） */
  updatedAt: string;
}

export interface RoleHistoryEntry {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 产物名（或任务一句话总结） */
  artifactLabel: string;
  /** 产物引用（artifact://... 或文件路径），没有则为 '-' */
  artifactRef: string;
  /** 产出摘要 */
  summary: string;
}

// ----------------------------------------------------------------------------
// 角色绑定检测（设计 §4.2）
// ----------------------------------------------------------------------------

/**
 * 检测一个 agent 是否为持久化角色：roles/<roleId>/ 目录存在即是。
 * agents/*.md 定义一个字都不改；删掉目录就降回普通瞬时 agent。
 */
export async function isPersistentRole(roleId: string): Promise<boolean> {
  if (!isSafeRoleId(roleId)) return false;
  try {
    const stat = await fs.stat(getRoleDir(roleId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** 列出所有持久化角色 ID（roles/ 下的子目录名） */
export async function listPersistentRoles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getRolesRootDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 创建角色资产目录骨架（幂等）。
 * 任何现有 agent 调用此函数即"升级为持久角色"。
 */
export async function ensureRoleAssetDirs(roleId: string): Promise<void> {
  if (!isSafeRoleId(roleId)) {
    throw new Error(`Invalid role id: "${roleId}"`);
  }
  await fs.mkdir(getRoleMemoriesDir(roleId), { recursive: true });
  const indexPath = getRoleMemoryIndexPath(roleId);
  if (!(await exists(indexPath))) {
    await fs.writeFile(indexPath, `# ${roleId} 角色记忆索引\n`, 'utf-8');
  }
  const historyPath = getRoleHistoryPath(roleId);
  if (!(await exists(historyPath))) {
    await fs.writeFile(historyPath, `# ${roleId} 工作履历\n`, 'utf-8');
  }
}

// ----------------------------------------------------------------------------
// 项目层（workspace hash 过渡 key，设计 §3.4）
// ----------------------------------------------------------------------------

/** 确保项目记忆目录存在 + meta.json 记录原始 workspace 路径（P0-2 迁移用） */
export async function ensureProjectMemoryDirs(workspacePath: string): Promise<void> {
  await fs.mkdir(getProjectMemoriesDir(workspacePath), { recursive: true });
  const metaPath = getProjectMetaPath(workspacePath);
  if (!(await exists(metaPath))) {
    const meta = {
      workspacePath: path.resolve(workspacePath),
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }
  const indexPath = getProjectMemoryIndexPath(workspacePath);
  if (!(await exists(indexPath))) {
    await fs.writeFile(indexPath, `# 项目记忆索引\n\n> workspace: ${path.resolve(workspacePath)}\n`, 'utf-8');
  }
}

// ----------------------------------------------------------------------------
// 记忆读写（角色层 / 项目层共用一套实现，只差目录）
// ----------------------------------------------------------------------------

interface ScopeDirs {
  memoriesDir: string;
  indexPath: string;
}

function resolveScopeDirs(scope: RoleMemoryScope, roleId: string | undefined, workspacePath: string | undefined): ScopeDirs {
  if (scope === 'role') {
    if (!roleId) throw new Error('role scope requires roleId');
    return { memoriesDir: getRoleMemoriesDir(roleId), indexPath: getRoleMemoryIndexPath(roleId) };
  }
  if (!workspacePath) throw new Error('project scope requires workspacePath');
  return { memoriesDir: getProjectMemoriesDir(workspacePath), indexPath: getProjectMemoryIndexPath(workspacePath) };
}

export interface ScopedMemoryTarget {
  scope: RoleMemoryScope;
  roleId?: string;
  workspacePath?: string;
}

/** 写入一条记忆（带 frontmatter）+ 更新该层索引 */
export async function writeScopedMemory(target: ScopedMemoryTarget, entry: RoleMemoryEntry): Promise<string> {
  const filename = sanitizeMemoryFilename(entry.filename);
  if (target.scope === 'role' && target.roleId) {
    await ensureRoleAssetDirs(target.roleId);
  } else if (target.scope === 'project' && target.workspacePath) {
    await ensureProjectMemoryDirs(target.workspacePath);
  }
  const dirs = resolveScopeDirs(target.scope, target.roleId, target.workspacePath);

  const safeName = guardText(entry.name, 1_000);
  const safeDescription = guardText(entry.description, 2_000);
  const safeContent = guardText(entry.content, 50_000);

  const fileContent = `---
name: ${safeName}
description: ${safeDescription}
scope: ${target.scope}
created: ${new Date().toISOString().slice(0, 10)}
---

${safeContent}
`;

  const filePath = path.join(dirs.memoriesDir, filename);
  await fs.writeFile(filePath, fileContent, 'utf-8');
  await updateScopedIndex(dirs.indexPath, filename, safeDescription);
  logger.info('Scoped memory written', { scope: target.scope, roleId: target.roleId, filename });
  return filePath;
}

/** 读取一条记忆正文 */
export async function readScopedMemory(target: ScopedMemoryTarget, filename: string): Promise<string | null> {
  const sanitized = sanitizeMemoryFilename(filename);
  const dirs = resolveScopeDirs(target.scope, target.roleId, target.workspacePath);
  try {
    return await fs.readFile(path.join(dirs.memoriesDir, sanitized), 'utf-8');
  } catch {
    return null;
  }
}

/** 删除一条记忆 + 更新索引（幂等） */
export async function deleteScopedMemory(target: ScopedMemoryTarget, filename: string): Promise<boolean> {
  const sanitized = sanitizeMemoryFilename(filename);
  const dirs = resolveScopeDirs(target.scope, target.roleId, target.workspacePath);
  let existed = true;
  try {
    await fs.unlink(path.join(dirs.memoriesDir, sanitized));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
  }
  await removeFromScopedIndex(dirs.indexPath, sanitized);
  return existed;
}

/** 列出某层全部记忆（UI / write gate 去重用） */
export async function listScopedMemories(target: ScopedMemoryTarget): Promise<RoleMemoryFile[]> {
  const dirs = resolveScopeDirs(target.scope, target.roleId, target.workspacePath);
  let filenames: string[] = [];
  try {
    filenames = (await fs.readdir(dirs.memoriesDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const files: RoleMemoryFile[] = [];
  for (const filename of filenames) {
    const filePath = path.join(dirs.memoriesDir, filename);
    try {
      const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
      const fm = parseFrontmatter(content);
      files.push({
        filename,
        name: fm.name || filename.replace(/\.md$/, ''),
        description: fm.description || '',
        content: fm.body,
        scope: target.scope,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch (err) {
      logger.warn('Failed to read scoped memory file', { filename, error: String(err) });
    }
  }
  return files;
}

/** 加载某层记忆索引（注入用，带行预算截断） */
export async function loadScopedMemoryIndex(target: ScopedMemoryTarget): Promise<string | null> {
  const dirs = resolveScopeDirs(target.scope, target.roleId, target.workspacePath);
  try {
    const content = await fs.readFile(dirs.indexPath, 'utf-8');
    if (!content.trim()) return null;
    const lines = content.split('\n');
    if (lines.length > ROLE_ASSETS.INDEX_MAX_LINES) {
      return lines.slice(0, ROLE_ASSETS.INDEX_MAX_LINES).join('\n') + '\n\n<!-- Truncated: index exceeds budget. -->';
    }
    return content.trim();
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 工作履历（设计 §4.3：履历 = 产物清单）
// ----------------------------------------------------------------------------

/** 追加一条履历（一行一条，最新的在最后） */
export async function appendRoleHistory(roleId: string, entry: RoleHistoryEntry): Promise<void> {
  await ensureRoleAssetDirs(roleId);
  const historyPath = getRoleHistoryPath(roleId);
  const label = entry.artifactRef && entry.artifactRef !== '-'
    ? `[${entry.artifactLabel}](${entry.artifactRef})`
    : entry.artifactLabel;
  const line = `- ${entry.date} | ${label} | ${entry.summary}\n`;
  await fs.appendFile(historyPath, line, 'utf-8');
}

/** 读取履历最近 N 条（注入 / UI 用） */
export async function loadRoleHistory(roleId: string, maxEntries?: number): Promise<string[]> {
  try {
    const content = await fs.readFile(getRoleHistoryPath(roleId), 'utf-8');
    const entries = content.split('\n').filter((line) => line.startsWith('- '));
    const limit = maxEntries ?? ROLE_ASSETS.INJECT_HISTORY_MAX_ENTRIES;
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// 注入块构建（设计 §3.3：索引常驻 + 正文按需）
// ----------------------------------------------------------------------------

/**
 * 为持久化角色构建 system prompt 注入块。
 * 内容 = 角色记忆索引 + 当前项目记忆索引 + 最近履历 + 使用规则。
 * 非持久角色返回 null（行为和今天完全一样）。
 */
export async function buildRoleContextBlock(roleId: string, workspacePath?: string): Promise<string | null> {
  if (!(await isPersistentRole(roleId))) return null;

  const sections: string[] = [];

  const roleIndex = await loadScopedMemoryIndex({ scope: 'role', roleId });
  sections.push(`## 角色记忆索引\n${roleIndex || '（暂无角色记忆）'}`);

  if (workspacePath) {
    const projectIndex = await loadScopedMemoryIndex({ scope: 'project', workspacePath });
    if (projectIndex) {
      sections.push(`## 当前项目记忆索引\n${projectIndex}`);
    }
  }

  const history = await loadRoleHistory(roleId);
  if (history.length > 0) {
    sections.push(`## 最近工作履历\n${history.join('\n')}`);
  }

  return [
    `<role_assets role="${roleId}">`,
    `你是持久化角色"${roleId}"。以下是你跨实例积累的长期资产（索引）：`,
    '',
    ...sections,
    '',
    '使用规则：',
    '- 索引中的记忆条目，需要详细内容时用 MemoryRead 工具读取（scope 参数填 "role" 或 "project"，filename 填索引中的文件名）。',
    '- 与当前任务相关的记忆应优先读取并运用，不要重复踩已记录过的坑。',
    '- 工作中发现"下次还有用"的知识，可用 MemoryWrite 工具（带 scope 参数）即时写入。',
    '</role_assets>',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// 主动性接口预留（设计 §9，本期只有 trigger: 'user' 路径）
// ----------------------------------------------------------------------------

export interface InstantiationContext {
  /** 任务描述 */
  task: string;
  /** 工作目录（项目记忆 key） */
  workspacePath?: string;
  /** 会话 ID */
  sessionId?: string;
}

export type InstantiationTrigger = 'user' | 'cadence' | 'event';

/**
 * 角色实例化统一入口（设计 §9 接口预留）。
 *
 * 本期只有 trigger='user' 路径：用户通过 spawn_agent / @角色名 唤起，
 * 实际 spawn 由现有 executeSpawnAgent 链路执行，本函数只做角色资产侧的准备
 * （确保目录骨架存在）并返回角色上下文。
 *
 * 下期主动性：Hook cadence 触发器调同一个入口传 'cadence'。
 */
export async function instantiateRole(
  roleName: string,
  trigger: InstantiationTrigger,
  context: InstantiationContext,
): Promise<{ roleId: string; trigger: InstantiationTrigger; contextBlock: string | null }> {
  if (trigger !== 'user') {
    throw new Error(`Instantiation trigger "${trigger}" is not implemented yet (reserved for proactivity phase)`);
  }
  const contextBlock = await buildRoleContextBlock(roleName, context.workspacePath);
  return { roleId: roleName, trigger, contextBlock };
}

// ----------------------------------------------------------------------------
// 内部 helpers
// ----------------------------------------------------------------------------

function sanitizeMemoryFilename(filename: string): string {
  if (!filename.endsWith('.md')) {
    throw new Error(`Memory filename must end with .md: "${filename}"`);
  }
  const sanitized = path.basename(filename);
  if (sanitized !== filename) {
    throw new Error(`Memory filename must not contain path separators: "${filename}"`);
  }
  return sanitized;
}

function guardText(value: string, maxLength: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 索引格式与全局 Light Memory INDEX.md 一致：- [filename](filename) — description */
async function updateScopedIndex(indexPath: string, filename: string, description: string): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await fs.readFile(indexPath, 'utf-8')).split('\n');
  } catch {
    lines = ['# 记忆索引', ''];
  }
  const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\]`);
  lines = lines.filter((line) => !entryPattern.test(line));
  lines.push(`- [${filename}](${ROLE_ASSETS.MEMORIES_SUBDIR}/${filename}) — ${description}`);
  await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
}

async function removeFromScopedIndex(indexPath: string, filename: string): Promise<void> {
  try {
    const existing = await fs.readFile(indexPath, 'utf-8');
    const entryPattern = new RegExp(`^- \\[${escapeRegex(filename)}\\].*$`, 'gm');
    const updated = existing.replace(entryPattern, '').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(indexPath, updated, 'utf-8');
  } catch {
    // 索引不存在 — 无需删除
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { name: fm.name, description: fm.description, body: match[2].trim() };
}
