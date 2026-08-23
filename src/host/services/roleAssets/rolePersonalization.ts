// ============================================================================
// Role Personalization — 每专家的「用户期望」「行为准则」与结构化硬边界
// ============================================================================
//
// 两份可编辑正文和一份结构化硬边界，落在专家自己的资产目录里：
//   roles/<roleId>/USER.md   ← 用户对这位专家的期望（建专家时那句原话，之后可改）
//   roles/<roleId>/SOUL.md   ← 这位专家的行为准则（留空则不注入）
//   roles/<roleId>/BOUNDARIES.json ← 系统强制执行的边界（关闭全部边界时文件不存在）
//
// 读取时机：每次 getAgentPrompt() 现读现拼，不进 agent 注册表缓存。
// 注册表的 chokidar 只 watch agents/ 目录，这两份文件改了它收不到通知；
// 现读现拼是唯一能保证「编辑完下一次派活就生效」的做法，代价是每次派活多
// 两次小文件读（相对一次模型调用可忽略）。
// ============================================================================

import * as fs from 'fs';
import {
  getRoleBoundariesPath,
  getRoleUserExpectationPath,
  getRoleSoulPath,
  isSafeRoleId,
} from './roleAssetPaths';
import { isExternalSideEffectTool } from '../../tools/externalSideEffect';

/** 单份正文注入上限：够写满一页指引，又不至于让用户手滑粘贴整本文档撑爆上下文。 */
const MAX_SECTION_CHARS = 8000;

export interface RolePersonalization {
  userExpectation: string;
  soul: string;
  boundaries: RoleBoundaries;
}

interface RoleBoundaries {
  disallowExternalSending: boolean;
}

export interface RoleToolBoundary {
  boundaryText: string;
  allowedTools: string[];
  blockedTools: string[];
}

const ROLE_BOUNDARY_DENY_ALL_SENTINEL = '__role_boundary_deny_all__';
const NO_EXTERNAL_SENDING_BOUNDARY_TEXT = '不允许对外发送';
const NO_ROLE_BOUNDARIES: RoleBoundaries = { disallowExternalSending: false };

/**
 * 把结构化的「不允许对外发送」边界翻译为已有 equipment.tools 白名单的收窄结果。
 * 没有开启硬边界时返回 null，调用方必须保持原行为逐字不变。
 */
export function resolveRoleToolBoundary(roleId: string, equipmentTools: readonly string[]): RoleToolBoundary | null {
  const { disallowExternalSending } = readRolePersonalization(roleId).boundaries;
  if (!disallowExternalSending) return null;
  const allowedTools = equipmentTools.filter((tool) => !isExternalSideEffectTool(tool));
  const allowed = new Set(allowedTools);
  return {
    boundaryText: NO_EXTERNAL_SENDING_BOUNDARY_TEXT,
    allowedTools,
    blockedTools: equipmentTools.filter((tool) => !allowed.has(tool)),
  };
}

/** 主轮旧契约把 [] 当“未设置 allowlist”；用不可解析哨兵表达真正的空白名单。 */
export function toRoleBoundaryRunAllowlist(tools: readonly string[]): string[] {
  return tools.length > 0 ? [...tools] : [ROLE_BOUNDARY_DENY_ALL_SENTINEL];
}

/** 在子代理分流前统一收窄 request，native / external engine 共用。 */
export function applyRoleBoundaryToSubagentRequest<
  T extends { config: { roleId?: string; availableTools: string[] } },
>(request: T): T {
  const boundary = request.config.roleId
    ? resolveRoleToolBoundary(request.config.roleId, request.config.availableTools)
    : null;
  return boundary
    ? { ...request, config: { ...request.config, availableTools: boundary.allowedTools } }
    : request;
}

/** 安全边界是运行约束，进入角色上下文块；没有设置时不增加任何字符。 */
export function buildRoleBoundaryContextSection(roleId: string): string {
  const { disallowExternalSending } = readRolePersonalization(roleId).boundaries;
  return disallowExternalSending ? `## 常驻边界\n${NO_EXTERNAL_SENDING_BOUNDARY_TEXT}` : '';
}

/** 语音只取短安全指令，不注入记忆索引、履历或资料架。 */
export function buildVoiceRoleBoundaryDirective(roleId: string): string {
  const { disallowExternalSending } = readRolePersonalization(roleId).boundaries;
  return disallowExternalSending ? `常驻边界：${NO_EXTERNAL_SENDING_BOUNDARY_TEXT}` : '';
}

function readIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    // 文件不存在是常态（专家从没设置过），不是错误
    return '';
  }
}

function readRoleBoundaries(filePath: string): RoleBoundaries {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (
      typeof parsed !== 'object'
      || parsed === null
      || typeof (parsed as Partial<RoleBoundaries>).disallowExternalSending !== 'boolean'
    ) {
      return { disallowExternalSending: true };
    }
    return { disallowExternalSending: (parsed as RoleBoundaries).disallowExternalSending };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...NO_ROLE_BOUNDARIES };
    // 文件存在却无法可靠解析时按最严格边界处理，避免安全配置损坏后静默放行。
    return { disallowExternalSending: true };
  }
}

/** 读这位专家的两份正文与硬边界；角色 id 不安全或文件缺失时返回默认值，绝不抛。 */
export function readRolePersonalization(roleId: string): RolePersonalization {
  if (!isSafeRoleId(roleId)) return { userExpectation: '', soul: '', boundaries: { ...NO_ROLE_BOUNDARIES } };
  try {
    return {
      userExpectation: readIfPresent(getRoleUserExpectationPath(roleId)),
      soul: readIfPresent(getRoleSoulPath(roleId)),
      boundaries: readRoleBoundaries(getRoleBoundariesPath(roleId)),
    };
  } catch {
    return { userExpectation: '', soul: '', boundaries: { ...NO_ROLE_BOUNDARIES } };
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
  const targets: Array<['userExpectation' | 'soul', string]> = [
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
  if (patch.boundaries !== undefined) {
    const filePath = getRoleBoundariesPath(roleId);
    if (patch.boundaries.disallowExternalSending) {
      fs.writeFileSync(filePath, `${JSON.stringify(patch.boundaries, null, 2)}\n`, 'utf-8');
    } else {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 全部硬边界关闭时不保留文件，与“从没设置过”同义。
      }
    }
  }
}
