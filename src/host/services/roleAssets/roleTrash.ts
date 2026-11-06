// ============================================================================
// Role Trash — 用户自建角色的可撤销删除（N-ROLE-CREATE-DIRECT-DELETE）
//
// 删除不是 rm：把角色名下的两份资产移进回收站，30 天内可整份还原。
//   agents/<roleId>.md      → roles-trash/<trashId>/agent.md
//   roles/<roleId>/         → roles-trash/<trashId>/<roleId>/
//   （meta.json 记 roleId + deletedAt，写在两份资产都落位之后——没有 meta 的目录
//    视为半途中断的残骸，purge 直接清掉，不参与还原。）
//
// 不可删（owner 拍板，终局）：BUILTIN_ROLE_IDS（含退役预设）、装了角色包的角色、
// 没有定义文件的孤儿角色。拒绝一律带稳定 code，文件一个字节不动。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getUserConfigDir, getAgentsMdDir } from '../../config/configPaths';
import { ROLE_ASSETS } from '../../../shared/constants';
import { BUILTIN_ROLE_IDS } from './builtinRoles';
import { getRoleDir, isSafeRoleId } from './roleAssetPaths';
import { getInstalledRolePackState } from './rolePackInstallService';
import { createLogger } from '../infra/logger';

const logger = createLogger('RoleTrash');

// ----------------------------------------------------------------------------
// 类型与错误码（稳定 code，renderer 侧翻译；host 不写中文错误文案）
// ----------------------------------------------------------------------------

type RoleTrashErrorCode =
  | 'ROLE_DELETE_INVALID_ID'
  | 'ROLE_DELETE_BUILTIN'
  | 'ROLE_DELETE_PACK_INSTALLED'
  | 'ROLE_DELETE_ORPHAN'
  | 'ROLE_DELETE_NOT_FOUND'
  | 'ROLE_TRASH_NOT_FOUND'
  | 'ROLE_RESTORE_CONFLICT';

interface RoleTrashMeta {
  roleId: string;
  /** 删除时刻（ISO 字符串）；retention 按它计算 */
  deletedAt: string;
}

type RoleDeleteGuard =
  | { deletable: true }
  | { deletable: false; code: RoleTrashErrorCode; message: string };

type TrashUserRoleResult =
  | { success: true; trashId: string }
  | { success: false; code: RoleTrashErrorCode; message: string };

type RestoreTrashedRoleResult =
  | { success: true; roleId: string }
  | { success: false; code: RoleTrashErrorCode; message: string };

// ----------------------------------------------------------------------------
// 路径
// ----------------------------------------------------------------------------

/** 回收站根目录：~/.code-agent/roles-trash/ */
function getRolesTrashRootDir(): string {
  return path.join(getUserConfigDir(), ROLE_ASSETS.TRASH_DIR_NAME);
}

function getRoleDefinitionPath(roleId: string): string {
  return path.join(getAgentsMdDir().user, `${roleId}.md`);
}

// ----------------------------------------------------------------------------
// 可删守卫
// ----------------------------------------------------------------------------

/**
 * 只有「用户自建」的角色可删。四类拒绝（均为稳定 code，文件不动）：
 * - 内置/退役预设（BUILTIN_ROLE_IDS）
 * - 装了角色包（role-packs.json 有记录；还原出厂语义归角色包管，删除入口不抢）
 * - 孤儿（roles/<id>/ 在、agents/<id>.md 不在——没有定义可移动）
 * - 角色目录根本不存在（无东西可删）
 */
async function isDeletableUserRole(roleId: string): Promise<RoleDeleteGuard> {
  if (!isSafeRoleId(roleId)) {
    return { deletable: false, code: 'ROLE_DELETE_INVALID_ID', message: `Invalid role id: "${roleId}"` };
  }
  if (BUILTIN_ROLE_IDS.includes(roleId)) {
    return { deletable: false, code: 'ROLE_DELETE_BUILTIN', message: 'Built-in roles cannot be deleted' };
  }
  if (await getInstalledRolePackState(roleId)) {
    return { deletable: false, code: 'ROLE_DELETE_PACK_INSTALLED', message: 'Roles with an installed role pack cannot be deleted; uninstall the pack first' };
  }
  if (!(await exists(getRoleDir(roleId)))) {
    return { deletable: false, code: 'ROLE_DELETE_NOT_FOUND', message: `Role directory not found: roles/${roleId}/` };
  }
  if (!(await exists(getRoleDefinitionPath(roleId)))) {
    return { deletable: false, code: 'ROLE_DELETE_ORPHAN', message: `Role definition not found: agents/${roleId}.md (orphan role)` };
  }
  return { deletable: true };
}

// ----------------------------------------------------------------------------
// 删除 / 还原
// ----------------------------------------------------------------------------

/** trashId 只做目录名（ascii 安全），真实 roleId 永远以 meta.json 为准（可能是中文）。 */
function newTrashId(now: Date): string {
  return `role-${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 把用户自建角色移入回收站（先过守卫，再惰性清理过期条目）。
 * 移动用 rename（同一数据目录内，原子且不复制数据）；meta.json 最后写。
 */
export async function trashUserRole(roleId: string, now: Date = new Date()): Promise<TrashUserRoleResult> {
  const guard = await isDeletableUserRole(roleId);
  if (!guard.deletable) {
    logger.warn('Role delete rejected', { roleId, code: guard.code });
    return { success: false, code: guard.code, message: guard.message };
  }

  await purgeExpiredTrash(now.getTime());

  const trashId = newTrashId(now);
  const trashDir = path.join(getRolesTrashRootDir(), trashId);
  await fs.mkdir(trashDir, { recursive: true });
  await fs.rename(getRoleDefinitionPath(roleId), path.join(trashDir, ROLE_ASSETS.TRASH_AGENT_FILENAME));
  await fs.rename(getRoleDir(roleId), path.join(trashDir, roleId));
  const meta: RoleTrashMeta = { roleId, deletedAt: now.toISOString() };
  await fs.writeFile(path.join(trashDir, ROLE_ASSETS.TRASH_META_FILENAME), JSON.stringify(meta, null, 2), 'utf-8');

  logger.info('Role moved to trash', { roleId, trashId, deletedAt: meta.deletedAt });
  return { success: true, trashId };
}

/**
 * 从回收站整份还原。目标 roleId 已被重新占用时拒绝且一个字节不覆盖
 * （用户可以自己处理冲突，工具不许替用户决定覆盖谁）。
 */
export async function restoreTrashedRole(trashId: string, now: Date = new Date()): Promise<RestoreTrashedRoleResult> {
  await purgeExpiredTrash(now.getTime());

  const trashDir = path.join(getRolesTrashRootDir(), path.basename(trashId));
  let meta: RoleTrashMeta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(trashDir, ROLE_ASSETS.TRASH_META_FILENAME), 'utf-8')) as RoleTrashMeta;
  } catch {
    return { success: false, code: 'ROLE_TRASH_NOT_FOUND', message: `Trashed role not found: ${trashId}` };
  }
  if (!isSafeRoleId(meta.roleId)) {
    return { success: false, code: 'ROLE_TRASH_NOT_FOUND', message: `Trashed role has an invalid role id: ${trashId}` };
  }

  if ((await exists(getRoleDefinitionPath(meta.roleId))) || (await exists(getRoleDir(meta.roleId)))) {
    return {
      success: false,
      code: 'ROLE_RESTORE_CONFLICT',
      message: `A role named "${meta.roleId}" already exists; nothing was overwritten`,
    };
  }

  await fs.mkdir(path.dirname(getRoleDefinitionPath(meta.roleId)), { recursive: true });
  await fs.rename(path.join(trashDir, ROLE_ASSETS.TRASH_AGENT_FILENAME), getRoleDefinitionPath(meta.roleId));
  await fs.mkdir(path.dirname(getRoleDir(meta.roleId)), { recursive: true });
  await fs.rename(path.join(trashDir, meta.roleId), getRoleDir(meta.roleId));
  await fs.rm(trashDir, { recursive: true, force: true });

  logger.info('Role restored from trash', { roleId: meta.roleId, trashId });
  return { success: true, roleId: meta.roleId };
}

// ----------------------------------------------------------------------------
// 惰性过期清理（无新定时器：trash/restore 顺带跑）
// ----------------------------------------------------------------------------

/**
 * 清掉超过 TRASH_RETENTION_DAYS 的条目；没有 meta.json 的残骸目录（删除中途崩掉的
 * 半成品）一并清——它们没有还原所需的完整信息，留着只是占地方。
 */
async function purgeExpiredTrash(now: number = Date.now()): Promise<{ purged: string[] }> {
  const root = getRolesTrashRootDir();
  let entries: Awaited<ReturnType<typeof listTrashEntries>>;
  try {
    entries = await listTrashEntries(root);
  } catch {
    return { purged: [] };
  }

  const retentionMs = ROLE_ASSETS.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const purged: string[] = [];
  for (const entry of entries) {
    const entryDir = path.join(root, entry.name);
    let deletedAt = Number.NaN;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(entryDir, ROLE_ASSETS.TRASH_META_FILENAME), 'utf-8')) as RoleTrashMeta;
      deletedAt = Date.parse(meta.deletedAt);
    } catch {
      // meta 缺失/损坏：按残骸处理，直接过期
    }
    if (Number.isFinite(deletedAt) && now - deletedAt < retentionMs) continue;
    await fs.rm(entryDir, { recursive: true, force: true });
    purged.push(entry.name);
  }
  if (purged.length > 0) {
    logger.info('Expired role trash purged', { purged, retentionDays: ROLE_ASSETS.TRASH_RETENTION_DAYS });
  }
  return { purged };
}

// ----------------------------------------------------------------------------
// internal
// ----------------------------------------------------------------------------

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listTrashEntries(root: string) {
  return (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
}
