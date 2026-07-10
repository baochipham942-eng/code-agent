// ============================================================================
// Child Context Builder - Builds child agent context from parent + config
// ============================================================================
//
// M2-Task 5 (partial) — childContext only, AgentTask/profile pending.
//
// 设计：plan §4.4 三档继承模式 + 合并算法。
// - strict-inherit（默认）：子 = 父真子集；tools ∩、deny ∪、mode 取更严，永不扩张
// - child-narrow：子可在父集合内声明更窄能力；仅父 mode ∈ {default, acceptEdits}
//   时允许子在父 allow 内自行扩 allow
// - independent：子完全独立，仍受 GuardFabric topology + 用户 deny 约束
// ============================================================================

import { buildProfilePrompt } from '../prompts/builder';
import type { ToolContext } from '../tools/types';

export type InheritanceMode = 'strict-inherit' | 'child-narrow' | 'independent';

export const DEFAULT_INHERITANCE_MODE: InheritanceMode = 'strict-inherit';

export interface ParentContext {
  rules: string[];
  memory: string[];
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  /** 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'delegate' | 'dontAsk' */
  permissionMode: string;
  availableTools: string[];
  /** 父级 deny 规则（来自 settings.permissions.deny + topology + preset blockedCommands 合集） */
  deny?: string[];
  /** 父级 ask 规则 */
  ask?: string[];
  /** 父级 allow 规则 */
  allow?: string[];
  /** 父级 blockedCommands（preset / ci 模式下的 blockedLevels 投影），随子 agent 继承 */
  blockedCommands?: string[];
  /** 父 agent 的 role/id，场景 D 兜底（readonly→writer 黑名单）用 */
  role?: string;
}

export interface ChildContextConfig {
  agentType: string;
  allowedTools: string[];
  mode?: string;
  readOnly?: boolean;
  /** 子 agent 自己声明的 deny 列表（可选） */
  deny?: string[];
  /** 子 agent 自己声明的 ask 列表（可选） */
  ask?: string[];
  /** 子 agent 自己声明的 allow 列表（可选） */
  allow?: string[];
  /** 子 agent 能力声明，配合 readonly→writer 黑名单 */
  capabilities?: string[];
}

export interface ChildContext {
  prompt: string;
  toolPool: string[];
  permissions: {
    inherited: string[]; // permission flags inherited from parent
    canEscalate: boolean; // always false — child can't escalate beyond parent
    /** 合并后的有效 deny */
    deny: string[];
    /** 合并后的有效 ask */
    ask: string[];
    /** 合并后的有效 allow */
    allow: string[];
    /** 合并后的有效 mode（已取父子较严者） */
    effectiveMode: string;
    /** 父级 blockedCommands（透传给 child）*/
    blockedCommands?: string[];
  };
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  memory: string[];
  /** 实际生效的继承模式（默认 strict-inherit） */
  inheritanceMode: InheritanceMode;
}

// ----------------------------------------------------------------------------
// Mode 取严
// ----------------------------------------------------------------------------

/** Plan §4.4 mode 取严：plan/dontAsk > readOnly > delegate > default > acceptEdits > bypassPermissions */
const MODE_RESTRICTIVENESS: Record<string, number> = {
  bypassPermissions: 0,
  acceptEdits: 1,
  default: 2,
  delegate: 3,
  readOnly: 4, // 只读探索：写/执行全走确认，比 default 严，比 plan（直接 deny）宽
  plan: 5,
  dontAsk: 6,
};

function moreRestrictiveMode(a: string, b: string): string {
  const ra = MODE_RESTRICTIVENESS[a] ?? 2;
  const rb = MODE_RESTRICTIVENESS[b] ?? 2;
  return ra >= rb ? a : b;
}

// ----------------------------------------------------------------------------
// 集合工具
// ----------------------------------------------------------------------------

function uniqUnion(a: readonly string[] = [], b: readonly string[] = []): string[] {
  return Array.from(new Set([...a, ...b]));
}

function uniqIntersect(a: readonly string[] = [], b: readonly string[] = []): string[] {
  const bs = new Set(b);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of a) {
    if (bs.has(item) && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// Role 黑名单（场景 D）
// ----------------------------------------------------------------------------

/** 这些父 role 永远不允许 spawn 出"会写"的子 agent（hard topology rule） */
export const READONLY_PARENT_ROLES: ReadonlySet<string> = new Set([
  'reviewer',
  'review',
  'code_reviewer',
  'explorer',
  'explore',
  'plan',
  'planner',
  'plan_agent',
]);

/** 这些子 role/capability 算"会写"的，readonly 父级不能 spawn */
export const WRITER_CHILD_CAPABILITIES: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'code_execution',
  'file_operations',
]);

/** writer 类 role 名称（spawnAgent 传 role 时用） */
export const WRITER_CHILD_ROLES: ReadonlySet<string> = new Set([
  'coder',
  'code',
  'fixer',
  'fix',
  'refactor',
  'refactorer',
  'debugger',
  'devops',
  'devops_engineer',
  'test_engineer',
  'tester',
]);

export interface ReadonlyParentCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 场景 D 兜底：父 role 是 readonly 时禁止 spawn writer 子 agent。
 * 这条规则不受 inheritance 配置影响（即便用户选了 independent 仍生效）。
 */
export function checkReadonlyParentRule(
  parentRole: string | undefined,
  childRole: string | undefined,
  childCapabilities: readonly string[] = [],
): ReadonlyParentCheckResult {
  if (!parentRole) return { allowed: true };
  const parentKey = parentRole.toLowerCase();
  if (!READONLY_PARENT_ROLES.has(parentKey)) return { allowed: true };

  const childRoleKey = (childRole ?? '').toLowerCase();
  if (childRoleKey && WRITER_CHILD_ROLES.has(childRoleKey)) {
    return {
      allowed: false,
      reason: `readonly parent role '${parentRole}' cannot spawn writer child role '${childRole}'`,
    };
  }
  for (const cap of childCapabilities) {
    if (WRITER_CHILD_CAPABILITIES.has(cap.toLowerCase())) {
      return {
        allowed: false,
        reason: `readonly parent role '${parentRole}' cannot spawn child with '${cap}' capability`,
      };
    }
  }
  return { allowed: true };
}

// ----------------------------------------------------------------------------
// 主入口：buildChildContext
// ----------------------------------------------------------------------------

export interface BuildChildContextOptions {
  inheritance?: InheritanceMode;
}

export function buildChildContext(
  config: ChildContextConfig,
  parent: ParentContext,
  options: BuildChildContextOptions = {},
): ChildContext {
  const inheritanceMode = options.inheritance ?? DEFAULT_INHERITANCE_MODE;

  // 1. Prompt: subagent profile with slim rules
  const slimRules = config.readOnly ? parent.rules.slice(0, 3) : parent.rules;
  const slimMemory = config.readOnly ? parent.memory.slice(-5) : parent.memory;
  const prompt = buildProfilePrompt('subagent', {
    rules: slimRules,
    memory: slimMemory,
    mode: config.mode,
  });

  // 2. tools 交集（永不扩张）
  //    independent 模式下子工具仍受父工具集约束（topology + user deny 走 GuardFabric）
  const toolPool = uniqIntersect(parent.availableTools, config.allowedTools);

  // 3. deny 并集（永远叠加，三档模式都遵守）
  const denyMerged = uniqUnion(parent.deny ?? [], config.deny ?? []);

  // 4. mode 取更严（plan §4.4）
  const childMode = config.mode ?? 'default';
  const effectiveMode = moreRestrictiveMode(parent.permissionMode, childMode);

  // 5. 按 inheritance 模式裁剪 ask / allow
  let effectiveAsk: string[];
  let effectiveAllow: string[];
  if (inheritanceMode === 'strict-inherit') {
    // 子的 ask/allow 必须是父的子集；未声明时直接继承父
    effectiveAsk = config.ask ? uniqIntersect(parent.ask ?? [], config.ask) : [...(parent.ask ?? [])];
    effectiveAllow = config.allow ? uniqIntersect(parent.allow ?? [], config.allow) : [...(parent.allow ?? [])];
  } else if (inheritanceMode === 'child-narrow') {
    // 父 mode 宽松（default/acceptEdits）时允许子在父 (ask ∪ allow) 范围内自行扩 allow；
    // 否则等同 strict-inherit
    const parentPermissive = ['default', 'acceptEdits'].includes(parent.permissionMode);
    if (parentPermissive) {
      effectiveAsk = config.ask ? uniqIntersect(parent.ask ?? [], config.ask) : [...(parent.ask ?? [])];
      const parentBound = uniqUnion(parent.ask ?? [], parent.allow ?? []);
      effectiveAllow = config.allow ? uniqIntersect(parentBound, config.allow) : [...(parent.allow ?? [])];
    } else {
      effectiveAsk = config.ask ? uniqIntersect(parent.ask ?? [], config.ask) : [...(parent.ask ?? [])];
      effectiveAllow = config.allow ? uniqIntersect(parent.allow ?? [], config.allow) : [...(parent.allow ?? [])];
    }
  } else {
    // independent：子自己决定 ask/allow（仍受 GuardFabric topology + user deny）
    effectiveAsk = [...(config.ask ?? [])];
    effectiveAllow = [...(config.allow ?? [])];
  }

  // 6. permission flags
  const inherited: string[] = [];
  if (parent.permissionMode === 'bypassPermissions') inherited.push('bypassPermissions');
  if (parent.permissionMode === 'acceptEdits') inherited.push('acceptEdits');

  // 7. hooks / skills / mcp / memory：原样继承
  const hooks = [...parent.hooks];
  const skills = [...parent.skills];
  const mcpConnections = [...parent.mcpConnections];

  return {
    prompt,
    toolPool,
    permissions: {
      inherited,
      canEscalate: false,
      deny: denyMerged,
      ask: effectiveAsk,
      allow: effectiveAllow,
      effectiveMode,
      blockedCommands: parent.blockedCommands ? [...parent.blockedCommands] : undefined,
    },
    hooks,
    skills,
    mcpConnections,
    memory: slimMemory,
    inheritanceMode,
  };
}

// ----------------------------------------------------------------------------
// Helper: 从 ToolContext 推导 ParentContext（P4 caller 收敛点）
// ----------------------------------------------------------------------------

/**
 * 10+ caller 不在 10 个地方各写一遍 parentContext 字面量，统一从 ToolContext
 * 推导。subagentExecutor 跑 spawn 之前会被调一次，缺失字段安全 fallback。
 *
 * 当前阶段：从 ToolContext 显式字段读，缺失时返回 undefined 子段；
 * 后续 Task 5 full 接 profile-matrix 时这里会扩展。
 */
export function buildParentContextFromToolContext(
  ctx: ToolContext,
  overrides: Partial<ParentContext> = {},
): ParentContext {
  // ctx 上没有强类型字段暴露 rules/memory/hooks/skills；用 cast 取宽松字段，
  // 缺失时给空数组。permissionMode 必填，缺失时用 default。
  const wide = ctx as ToolContext & {
    parentRules?: string[];
    parentMemory?: string[];
    parentHooks?: unknown[];
    parentSkills?: string[];
    parentMcpConnections?: unknown[];
    parentDeny?: string[];
    parentAsk?: string[];
    parentAllow?: string[];
    parentBlockedCommands?: string[];
    parentAvailableTools?: string[];
    parentPermissionMode?: string;
  };

  return {
    rules: wide.parentRules ?? [],
    memory: wide.parentMemory ?? [],
    hooks: wide.parentHooks ?? [],
    skills: wide.parentSkills ?? [],
    mcpConnections: wide.parentMcpConnections ?? [],
    permissionMode: overrides.permissionMode ?? wide.parentPermissionMode ?? 'default',
    availableTools: wide.parentAvailableTools ?? [],
    deny: wide.parentDeny ?? [],
    ask: wide.parentAsk ?? [],
    allow: wide.parentAllow ?? [],
    blockedCommands: wide.parentBlockedCommands ?? [],
    role: ctx.agentRole,
    ...overrides,
  };
}
