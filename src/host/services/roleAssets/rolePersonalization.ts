// ============================================================================
// Role Personalization — 每专家的「用户期望」与「行为准则」
// ============================================================================
//
// 两份可编辑正文，落在专家自己的资产目录里：
//   roles/<roleId>/USER.md   ← 用户对这位专家的期望（建专家时那句原话，之后可改）
//   roles/<roleId>/SOUL.md   ← 这位专家的行为准则（留空则不注入）
//
// 读取时机：每次 getAgentPrompt() 现读现拼，不进 agent 注册表缓存。
// 注册表的 chokidar 只 watch agents/ 目录，这两份文件改了它收不到通知；
// 现读现拼是唯一能保证「编辑完下一次派活就生效」的做法，代价是每次派活多
// 两次小文件读（相对一次模型调用可忽略）。
// ============================================================================

import * as fs from 'fs';
import { getRoleUserExpectationPath, getRoleSoulPath, isSafeRoleId } from './roleAssetPaths';

/** 单份正文注入上限：够写满一页指引，又不至于让用户手滑粘贴整本文档撑爆上下文。 */
const MAX_SECTION_CHARS = 8000;

export interface RolePersonalization {
  userExpectation: string;
  soul: string;
}

function readIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    // 文件不存在是常态（专家从没设置过），不是错误
    return '';
  }
}

/** 读这位专家的两份正文；角色 id 不安全或文件缺失时返回空串，绝不抛。 */
export function readRolePersonalization(roleId: string): RolePersonalization {
  if (!isSafeRoleId(roleId)) return { userExpectation: '', soul: '' };
  try {
    return {
      userExpectation: readIfPresent(getRoleUserExpectationPath(roleId)),
      soul: readIfPresent(getRoleSoulPath(roleId)),
    };
  } catch {
    return { userExpectation: '', soul: '' };
  }
}

function section(title: string, body: string): string {
  const clamped = body.length > MAX_SECTION_CHARS ? `${body.slice(0, MAX_SECTION_CHARS)}\n…（内容过长，已截断）` : body;
  return `\n\n---\n\n# ${title}\n\n${clamped}`;
}

/**
 * 把两份正文接到 system prompt 尾部。两份都空时原样返回，
 * 保证没设置过的专家行为与改造前逐字一致。
 */
export function appendRolePersonalization(prompt: string, roleId: string): string {
  const { userExpectation, soul } = readRolePersonalization(roleId);
  let result = prompt;
  if (userExpectation) result += section('协作者对你的期望', userExpectation);
  if (soul) result += section('你的行为准则', soul);
  return result;
}

/** 写回单份正文；空串表示清空（删文件，与"从没设置过"同义）。 */
export function writeRolePersonalization(roleId: string, patch: Partial<RolePersonalization>): void {
  if (!isSafeRoleId(roleId)) throw new Error(`Invalid role id: "${roleId}"`);
  const targets: Array<[keyof RolePersonalization, string]> = [
    ['userExpectation', getRoleUserExpectationPath(roleId)],
    ['soul', getRoleSoulPath(roleId)],
  ];
  for (const [key, filePath] of targets) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value.trim()) {
      fs.writeFileSync(filePath, value, 'utf-8');
    } else {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 本来就没有这份文件，清空即达成
      }
    }
  }
}
