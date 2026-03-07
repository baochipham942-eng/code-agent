// ============================================================================
// @Tool Decorator - 工具元数据装饰器
// ============================================================================
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import 'reflect-metadata';
import {
  TOOL_METADATA_KEY,
  type ToolOptions,
  type ToolMetadataStored,
} from './types';

// ----------------------------------------------------------------------------
// @Tool Decorator
// ----------------------------------------------------------------------------

/**
 * 工具装饰器
 *
 * @example
 * ```typescript
 * @Tool('read_file', {
 *   permission: 'read',
 * })
 * class ReadFileTool implements ITool {
 *   async execute(params, context) { ... }
 * }
 * ```
 */
export function Tool(name: string, options: ToolOptions): ClassDecorator {
  return (target: Function) => {
    const metadata: ToolMetadataStored = {
      name,
      permission: options.permission || 'none',
      requiresConfirmation: options.requiresConfirmation || false,
    };

    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);
  };
}

/**
 * 获取工具元数据
 */
export function getToolMetadata(target: Function): ToolMetadataStored | undefined {
  return Reflect.getMetadata(TOOL_METADATA_KEY, target);
}
