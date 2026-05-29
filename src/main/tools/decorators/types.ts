// ============================================================================
// Tool Decorator Types
// ============================================================================

import type { JSONSchema } from '../../../shared/contract';
import type { ToolContext, ToolExecutionResult } from '../types';

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

// Tool Options
// ----------------------------------------------------------------------------

export interface ToolOptions {
  /** 权限级别 */
  permission?: 'read' | 'write' | 'execute' | 'network' | 'none';
  /** 是否需要用户确认 */
  requiresConfirmation?: boolean;
}

// ----------------------------------------------------------------------------
// Parameter Options
// ----------------------------------------------------------------------------

export interface ParamOptions {
  /** 参数类型 */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** 是否必需 */
  required?: boolean;
  /** 默认值 */
  default?: unknown;
  /** 参数描述 */
  description?: string;
  /** 枚举值（用于 string 类型） */
  enum?: string[];
  /** 数组元素类型 */
  items?: { type: string };
}

// ----------------------------------------------------------------------------
// Tool Interface (Class-based)
// ----------------------------------------------------------------------------

/**
 * 基于类的工具接口
 * 装饰器定义的工具类需要实现此接口
 */
export interface ITool {
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}

/**
 * 工具类构造函数类型
 */
export interface ToolConstructor {
  new (): ITool;
}

// ----------------------------------------------------------------------------
// Metadata Keys
// ----------------------------------------------------------------------------

export const TOOL_METADATA_KEY = Symbol('tool:metadata');
export const PARAMS_METADATA_KEY = Symbol('tool:params');
export const DESCRIPTION_METADATA_KEY = Symbol('tool:description');

// ----------------------------------------------------------------------------
// Stored Metadata Types
// ----------------------------------------------------------------------------

export interface ToolMetadataStored {
  name: string;
  permission: 'read' | 'write' | 'execute' | 'network' | 'none';
  requiresConfirmation: boolean;
}

export interface ParamMetadataStored {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
  items?: { type: string };
}
