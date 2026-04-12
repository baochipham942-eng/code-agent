// ============================================================================
// Tool Definitions Facade — 业务层工具定义聚合
//
// 原属 toolRegistry.ts 的 getCoreToolDefinitions / getLoadedDeferredToolDefinitions
// / getDeferredToolsSummary / cloud meta 合并，P0-6.2 抽出为独立模块。
//
// 职责定位：
//   - protocol registry 只管 schema + handler 解析（registry.ts / protocolRegistry.ts）
//   - 业务层（本文件）负责把 protocol schema 映射成 ToolDefinition 并合并 cloud meta
//   - contextAssembly 消费的是本文件导出的自由函数，不再穿透 ctx.toolRegistry
//
// 跨服务依赖：
//   - getProtocolRegistry() → tool schema 源
//   - getCloudConfigService() → 云端 description override
//   - getToolSearchService() → 延迟加载已解锁的工具名
// ============================================================================

import type { ToolDefinition } from '../../shared/contract';
import type { ToolSchema, PermissionLevel } from '../protocol/tools';
import { getProtocolRegistry } from './protocolRegistry';
import { getCloudConfigService } from '../services/cloud';
import { CORE_TOOLS, DEFERRED_TOOLS_META, getToolSearchService } from './search';

type LegacyPermissionLevel = 'read' | 'write' | 'execute' | 'network';

function mapPermissionLevel(level: PermissionLevel): LegacyPermissionLevel {
  if (level === 'dangerous') return 'execute';
  return level;
}

/**
 * 把 protocol ToolSchema 映射成 ToolDefinition，合并 cloud meta。
 * description 优先级: cloud > dynamic > static schema.description
 */
function schemaToDefinition(
  schema: ToolSchema,
  cloudMeta: Record<string, { description?: string }>,
): ToolDefinition {
  const cloud = cloudMeta[schema.name];
  const description =
    cloud?.description || schema.dynamicDescription?.() || schema.description;
  return {
    name: schema.name,
    description,
    inputSchema: schema.inputSchema,
    requiresPermission: schema.permissionLevel !== 'read',
    permissionLevel: mapPermissionLevel(schema.permissionLevel),
  };
}

/**
 * 获取核心工具定义（始终发送给模型）
 *
 * 核心工具是最常用的基础工具，始终包含在模型请求中。
 * 其他工具需要通过 tool_search 发现和加载。
 */
export function getCoreToolDefinitions(): ToolDefinition[] {
  const registry = getProtocolRegistry();
  const cloudToolMeta = getCloudConfigService().getAllToolMeta();
  const core = new Set(CORE_TOOLS);

  return registry
    .getSchemas()
    .filter((schema) => core.has(schema.name))
    .map((schema) => schemaToDefinition(schema, cloudToolMeta));
}

/**
 * 获取延迟工具定义（全量）
 *
 * 延迟工具不会默认发送给模型，需要通过 tool_search 加载后才可用。
 */
export function getDeferredToolDefinitions(): ToolDefinition[] {
  const registry = getProtocolRegistry();
  const cloudToolMeta = getCloudConfigService().getAllToolMeta();
  const core = new Set(CORE_TOOLS);

  return registry
    .getSchemas()
    .filter((schema) => !core.has(schema.name))
    .map((schema) => schemaToDefinition(schema, cloudToolMeta));
}

/**
 * 获取已加载的延迟工具定义
 *
 * 只返回已通过 tool_search 加载的延迟工具。
 */
export function getLoadedDeferredToolDefinitions(): ToolDefinition[] {
  const registry = getProtocolRegistry();
  const toolSearchService = getToolSearchService();
  const loadedNames = new Set(toolSearchService.getLoadedDeferredTools());
  const cloudToolMeta = getCloudConfigService().getAllToolMeta();

  return registry
    .getSchemas()
    .filter((schema) => loadedNames.has(schema.name))
    .map((schema) => schemaToDefinition(schema, cloudToolMeta));
}

/**
 * 获取延迟工具摘要（用于 system prompt 提示）
 *
 * 返回延迟工具名称列表，提示模型可通过 tool_search 发现这些工具。
 */
export function getDeferredToolsSummary(): string {
  const grouped = new Map<string, string[]>();
  for (const meta of DEFERRED_TOOLS_META) {
    const category = meta.tags[0] || 'other';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category)!.push(`${meta.name}: ${meta.shortDescription}`);
  }

  const lines: string[] = [];
  for (const [category, tools] of grouped) {
    lines.push(`[${category}] ${tools.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * 获取指定工具的定义（带 cloud meta 合并）
 *
 * @returns ToolDefinition 或 undefined（未注册）
 */
export function getToolDefinitionWithCloudMeta(name: string): ToolDefinition | undefined {
  const registry = getProtocolRegistry();
  const schemas = registry.getSchemas();
  const schema = schemas.find((s) => s.name === name);
  if (!schema) return undefined;
  const cloudToolMeta = getCloudConfigService().getAllToolMeta();
  return schemaToDefinition(schema, cloudToolMeta);
}

/**
 * 获取全部已注册工具的定义（core + deferred 全集，带 cloud meta）
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  const registry = getProtocolRegistry();
  const cloudToolMeta = getCloudConfigService().getAllToolMeta();
  return registry.getSchemas().map((schema) => schemaToDefinition(schema, cloudToolMeta));
}
