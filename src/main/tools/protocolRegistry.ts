// ============================================================================
// Protocol Tool Registry — 单例 + 工具注册
//
// 职责：
// 1. 暴露 getProtocolRegistry() 单例，首次调用时 lazy 创建 + 注册 POC 与迁移工具
// 2. 暴露 isProtocolExposeEnabled() 读 env，决定是否把 POC schema 暴露给 LLM
// 3. 暴露 isProtocolToolName() 判断一个工具名是否在 protocol registry 中
//
// 和 legacy toolRegistry.ts 完全独立，不互相 import。
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

/** 判断一个 tool 名字是否已在 protocol registry 中注册 */
export function isProtocolToolName(name: string): boolean {
  return getProtocolRegistry().has(name);
}
