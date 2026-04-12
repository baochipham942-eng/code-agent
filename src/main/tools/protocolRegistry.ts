// ============================================================================
// Protocol Tool Registry — 单例 + POC 工具注册
//
// 职责：
// 1. 暴露 getProtocolRegistry() 单例，首次调用时 lazy 创建 + 注册 POC 工具
// 2. 暴露 isProtocolShadowEnabled() 读 env，避免生产路径误触发
// 3. 暴露 resolveShadowToolName(oldName) 做旧名 → POC 名的映射（仅 3 个白名单）
//
// 和旧 toolRegistry.ts 完全独立，不互相 import。shadow 模式下由 toolExecutor
// 同时持有两个 registry 句柄，旧路径结果为准、新路径仅比对。
// ============================================================================

import { ToolRegistry, registerPocTools } from './registry';
import { registerMigratedTools } from './migrated';
import type { ToolSchema, PermissionLevel } from '../protocol/tools';

let singleton: ToolRegistry | null = null;

/** 单例访问，首次调用时注册 POC schema + 已迁移 tool */
export function getProtocolRegistry(): ToolRegistry {
  if (!singleton) {
    singleton = new ToolRegistry();
    registerPocTools(singleton);
    registerMigratedTools(singleton);
  }
  return singleton;
}

/** 测试用：重置单例，让下一次 get 重新注册 */
export function resetProtocolRegistry(): void {
  singleton = null;
}

/** 读 env 判断 shadow 模式是否开启。默认关闭，生产路径零开销 */
export function isProtocolShadowEnabled(): boolean {
  return process.env.TOOL_PROTOCOL_SHADOW === '1';
}

/**
 * 读 env 判断是否把 POC tool schema 暴露给 LLM。
 * 开启时 contextAssembly 会把 POC schema 加到 tools 列表里，让模型能调 ReadPoc/...
 * 默认关闭——生产路径不应让模型看到 POC tool。
 */
export function isProtocolExposeEnabled(): boolean {
  return process.env.TOOL_PROTOCOL_EXPOSE_POC === '1';
}

/**
 * 把 POC ToolSchema 转成旧 ToolDefinition 形态（contextAssembly 直接消费）。
 * 字段映射：
 * - name / description / inputSchema → 直接
 * - permissionLevel: 'dangerous' 在 legacy 没对应值，降级为 'execute'
 * - requiresPermission → permissionLevel !== 'read'（read tool 默认不弹权限）
 */
type LegacyPermissionLevel = 'read' | 'write' | 'execute' | 'network';

export interface PocToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema['inputSchema'];
  requiresPermission: boolean;
  permissionLevel: LegacyPermissionLevel;
}

function mapPermissionLevel(level: PermissionLevel): LegacyPermissionLevel {
  if (level === 'dangerous') return 'execute';
  return level;
}

export function getPocToolDefinitions(): PocToolDefinition[] {
  const registry = getProtocolRegistry();
  return registry.getSchemas().map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
    requiresPermission: schema.permissionLevel !== 'read',
    permissionLevel: mapPermissionLevel(schema.permissionLevel),
  }));
}

/** 判断一个 tool 名字是 POC 的（registry 里有，但不在 SHADOW_TOOL_MAP 旧名集合里）*/
export function isPocToolName(name: string): boolean {
  return getProtocolRegistry().has(name);
}

/**
 * 白名单：旧 tool 名 → POC registry 里的 schema 名
 * 只有这三个在 shadow 下会并行跑新路径，其他 tool 一律跳过。
 */
const SHADOW_TOOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  Read: 'ReadPoc',
  read_file: 'ReadPoc',
  Bash: 'BashPoc',
  bash: 'BashPoc',
  WebSearch: 'WebSearchPoc',
  web_search: 'WebSearchPoc',
  Glob: 'GlobPoc',
  glob: 'GlobPoc',
  Grep: 'GrepPoc',
  grep: 'GrepPoc',
  WebFetch: 'WebFetchPoc',
  web_fetch: 'WebFetchPoc',
  // Write/Edit POC 是 DRY RUN，shadow 跑不会重复写盘
  Write: 'WritePoc',
  write_file: 'WritePoc',
  Edit: 'EditPoc',
  edit_file: 'EditPoc',
});

export function resolveShadowToolName(oldName: string): string | null {
  return SHADOW_TOOL_MAP[oldName] ?? null;
}
