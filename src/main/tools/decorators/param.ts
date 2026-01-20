// ============================================================================
// @Param Decorator - 参数定义装饰器
// ============================================================================
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import 'reflect-metadata';
import { PARAMS_METADATA_KEY, type ParamOptions, type ParamMetadataStored } from './types';

// ----------------------------------------------------------------------------
// @Param Decorator
// ----------------------------------------------------------------------------

/**
 * 参数装饰器
 * 注意：由于装饰器从下往上执行，定义顺序会相反
 *
 * @example
 * ```typescript
 * @Param('encoding', { type: 'string', default: 'utf-8', description: 'File encoding' })
 * @Param('file_path', { type: 'string', required: true, description: 'Path to file' })
 * class ReadFileTool implements ITool { ... }
 * ```
 */
export function Param(name: string, options: ParamOptions): ClassDecorator {
  return (target: Function) => {
    const existing: ParamMetadataStored[] = Reflect.getMetadata(PARAMS_METADATA_KEY, target) || [];

    const param: ParamMetadataStored = {
      name,
      type: options.type,
      required: options.required ?? false,
      default: options.default,
      description: options.description,
      enum: options.enum,
      items: options.items,
    };

    // 添加到数组开头（因为装饰器从下往上执行）
    existing.unshift(param);
    Reflect.defineMetadata(PARAMS_METADATA_KEY, existing, target);
  };
}

/**
 * 获取参数元数据
 */
export function getParamMetadata(target: Function): ParamMetadataStored[] {
  return Reflect.getMetadata(PARAMS_METADATA_KEY, target) || [];
}
