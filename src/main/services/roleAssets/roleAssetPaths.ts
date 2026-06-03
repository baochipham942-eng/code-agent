// ============================================================================
// Role Asset Paths — 持久化角色资产的目录布局
// ============================================================================
//
// 三层记忆目录结构（docs/designs/persistent-role-assets.md §3/§4）：
//   全局   ~/.code-agent/memory/                    ← 现有 Light Memory，不动
//   角色   ~/.code-agent/roles/<roleId>/             ← 本模块
//   项目   ~/.code-agent/projects/<key>/memory/      ← 本模块（workspace hash 过渡 key）
//
// 角色目录布局：
//   roles/<roleId>/
//   ├── MEMORY.md        ← 记忆索引（注入用）
//   ├── memories/*.md    ← 记忆正文
//   └── history.md       ← 工作履历（产物清单）
// ============================================================================

import * as path from 'path';
import * as crypto from 'crypto';
import { getUserConfigDir } from '../../config/configPaths';
import { ROLE_ASSETS } from '../../../shared/constants';

// ----------------------------------------------------------------------------
// 角色 ID 校验
// ----------------------------------------------------------------------------

/**
 * 校验角色 ID 可以安全用作目录名（防路径穿越）。
 * 角色 ID = agent 注册 id（agents/<id>.md 的 frontmatter name），允许中文。
 */
export function isSafeRoleId(roleId: string): boolean {
  if (!roleId || !roleId.trim()) return false;
  if (roleId !== path.basename(roleId)) return false;
  if (roleId === '.' || roleId === '..') return false;
  // 禁止路径分隔符和 null 字节
  return !/[/\\\0]/.test(roleId);
}

function assertSafeRoleId(roleId: string): void {
  if (!isSafeRoleId(roleId)) {
    throw new Error(`Invalid role id: "${roleId}"`);
  }
}

// ----------------------------------------------------------------------------
// 角色层路径
// ----------------------------------------------------------------------------

/** 角色资产根目录：~/.code-agent/roles/ */
export function getRolesRootDir(): string {
  return path.join(getUserConfigDir(), ROLE_ASSETS.ROLES_DIR);
}

/** 单个角色的资产目录：~/.code-agent/roles/<roleId>/ */
export function getRoleDir(roleId: string): string {
  assertSafeRoleId(roleId);
  return path.join(getRolesRootDir(), roleId);
}

/** 角色记忆索引：roles/<roleId>/MEMORY.md */
export function getRoleMemoryIndexPath(roleId: string): string {
  return path.join(getRoleDir(roleId), ROLE_ASSETS.INDEX_FILENAME);
}

/** 角色记忆正文目录：roles/<roleId>/memories/ */
export function getRoleMemoriesDir(roleId: string): string {
  return path.join(getRoleDir(roleId), ROLE_ASSETS.MEMORIES_SUBDIR);
}

/** 角色工作履历：roles/<roleId>/history.md */
export function getRoleHistoryPath(roleId: string): string {
  return path.join(getRoleDir(roleId), ROLE_ASSETS.HISTORY_FILENAME);
}

// ----------------------------------------------------------------------------
// 项目层路径（workspace hash 过渡 key，P0-2 项目空间落地后接管）
// ----------------------------------------------------------------------------

/** 项目记忆根目录：~/.code-agent/projects/ */
export function getProjectsRootDir(): string {
  return path.join(getUserConfigDir(), ROLE_ASSETS.PROJECTS_DIR);
}

/**
 * workspace 路径 → 项目 key（hash 截断）。
 * meta.json 记录原始路径，迁移时只换索引不动文件（设计 §3.4）。
 */
export function getProjectKey(workspacePath: string): string {
  const normalized = path.resolve(workspacePath);
  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, ROLE_ASSETS.PROJECT_KEY_LENGTH);
}

/** 项目目录：~/.code-agent/projects/<key>/ */
export function getProjectDir(workspacePath: string): string {
  return path.join(getProjectsRootDir(), getProjectKey(workspacePath));
}

/** 项目元数据：projects/<key>/meta.json */
export function getProjectMetaPath(workspacePath: string): string {
  return path.join(getProjectDir(workspacePath), ROLE_ASSETS.META_FILENAME);
}

/** 项目记忆目录：projects/<key>/memory/ */
export function getProjectMemoryDir(workspacePath: string): string {
  return path.join(getProjectDir(workspacePath), 'memory');
}

/** 项目记忆索引：projects/<key>/memory/MEMORY.md */
export function getProjectMemoryIndexPath(workspacePath: string): string {
  return path.join(getProjectMemoryDir(workspacePath), ROLE_ASSETS.INDEX_FILENAME);
}

/** 项目记忆正文目录：projects/<key>/memory/memories/ */
export function getProjectMemoriesDir(workspacePath: string): string {
  return path.join(getProjectMemoryDir(workspacePath), ROLE_ASSETS.MEMORIES_SUBDIR);
}
