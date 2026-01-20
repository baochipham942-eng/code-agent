// ============================================================================
// @Description Decorator - 工具描述装饰器
// ============================================================================

import 'reflect-metadata';
import { DESCRIPTION_METADATA_KEY } from './types';

// ----------------------------------------------------------------------------
// @Description Decorator
// ----------------------------------------------------------------------------

/**
 * 描述装饰器
 *
 * @example
 * ```typescript
 * @Description('Read the contents of a file from the filesystem')
 * @Tool('read_file', { ... })
 * class ReadFileTool implements ITool { ... }
 * ```
 */
export function Description(text: string): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(DESCRIPTION_METADATA_KEY, text, target);
  };
}

/**
 * 获取描述元数据
 */
export function getDescriptionMetadata(target: Function): string | undefined {
  return Reflect.getMetadata(DESCRIPTION_METADATA_KEY, target);
}
