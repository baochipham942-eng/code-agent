// ============================================================================
// Tool Builder - 从装饰器类构建 Tool 对象
// ============================================================================

import 'reflect-metadata';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { JSONSchema, JSONSchemaProperty } from '../../../shared/types';
import { getToolMetadata } from './tool';
import { getParamMetadata } from './param';
import { getDescriptionMetadata } from './description';
import type { ITool, ToolConstructor, ParamMetadataStored } from './types';

// ----------------------------------------------------------------------------
// Schema Builder
// ----------------------------------------------------------------------------

/**
 * 从参数元数据构建 JSON Schema
 */
function buildInputSchema(params: ParamMetadataStored[]): JSONSchema {
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];

  for (const param of params) {
    const propSchema: JSONSchemaProperty = {
      type: param.type,
    };

    if (param.description) {
      propSchema.description = param.description;
    }

    if (param.default !== undefined) {
      propSchema.default = param.default;
    }

    if (param.enum) {
      propSchema.enum = param.enum;
    }

    if (param.items) {
      propSchema.items = param.items;
    }

    properties[param.name] = propSchema;

    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

// ----------------------------------------------------------------------------
// Tool Builder
// ----------------------------------------------------------------------------

/**
 * 从装饰器类构建 Tool 对象
 *
 * @example
 * ```typescript
 * @Description('Read file contents')
 * @Tool('read_file', { generations: 'gen1+', permission: 'read' })
 * @Param('file_path', { type: 'string', required: true })
 * class ReadFileTool implements ITool {
 *   async execute(params, ctx) { ... }
 * }
 *
 * const tool = buildToolFromClass(ReadFileTool);
 * ```
 */
export function buildToolFromClass(ToolClass: ToolConstructor): Tool {
  const toolMeta = getToolMetadata(ToolClass);
  const paramMeta = getParamMetadata(ToolClass);
  const description = getDescriptionMetadata(ToolClass);

  if (!toolMeta) {
    throw new Error(`Class ${ToolClass.name} is not decorated with @Tool`);
  }

  if (!description) {
    throw new Error(`Class ${ToolClass.name} is not decorated with @Description`);
  }

  // 创建实例
  const instance = new ToolClass();

  // 构建 Tool 对象
  const tool: Tool = {
    name: toolMeta.name,
    description,
    generations: toolMeta.generations,
    requiresPermission: toolMeta.permission !== 'none',
    permissionLevel: toolMeta.permission === 'none' ? 'read' : toolMeta.permission,
    inputSchema: buildInputSchema(paramMeta),
    execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> => {
      return instance.execute(params, context);
    },
  };

  return tool;
}

/**
 * 批量从装饰器类构建 Tool 对象
 */
export function buildToolsFromClasses(classes: ToolConstructor[]): Tool[] {
  return classes.map(buildToolFromClass);
}
