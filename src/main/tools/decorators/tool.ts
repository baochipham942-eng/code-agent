// ============================================================================
// @Tool Decorator - 工具元数据装饰器
// ============================================================================

import 'reflect-metadata';
import type { GenerationId } from '../../../shared/types';
import {
  TOOL_METADATA_KEY,
  type ToolOptions,
  type GenerationSpec,
  type ToolMetadataStored,
} from './types';

// ----------------------------------------------------------------------------
// Generation Parsing
// ----------------------------------------------------------------------------

const ALL_GENERATIONS: GenerationId[] = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'];

/**
 * 解析代际指定
 * - 'gen1+' -> ['gen1', 'gen2', ..., 'gen8']
 * - 'gen3' -> ['gen3']
 * - ['gen1', 'gen2'] -> ['gen1', 'gen2']
 */
function parseGenerations(spec: GenerationSpec): GenerationId[] {
  if (Array.isArray(spec)) {
    return spec;
  }

  // 解析 'gen1+' 语法
  const plusMatch = spec.match(/^(gen\d)\+$/);
  if (plusMatch) {
    const startGen = plusMatch[1] as GenerationId;
    const startIndex = ALL_GENERATIONS.indexOf(startGen);
    if (startIndex === -1) {
      throw new Error(`Invalid generation: ${startGen}`);
    }
    return ALL_GENERATIONS.slice(startIndex);
  }

  // 单个代际
  if (ALL_GENERATIONS.includes(spec as GenerationId)) {
    return [spec as GenerationId];
  }

  throw new Error(`Invalid generation spec: ${spec}`);
}

// ----------------------------------------------------------------------------
// @Tool Decorator
// ----------------------------------------------------------------------------

/**
 * 工具装饰器
 *
 * @example
 * ```typescript
 * @Tool('read_file', {
 *   generations: 'gen1+',
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
      generations: parseGenerations(options.generations),
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
