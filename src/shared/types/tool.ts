// ============================================================================
// Tool Types
// ============================================================================

import type { Generation, GenerationId } from './generation';
import type { ModelConfig } from './model';
import type { PermissionRequest } from './permission';

export type PermissionLevel = 'read' | 'write' | 'execute' | 'network';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  generations: GenerationId[];
  requiresPermission: boolean;
  permissionLevel: PermissionLevel;
}

export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchemaProperty;
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  workingDirectory: string;
  currentGeneration: Generation;
  modelConfig: ModelConfig;
  requestPermission: (request: PermissionRequest) => Promise<boolean>;
  emit: (event: string, data: unknown) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Result is attached by the UI when tool_call_end event is received
  result?: ToolResult;
  // 流式工具调用的临时属性
  _streaming?: boolean; // 标记是否正在流式接收中
  _argumentsRaw?: string; // 累积的原始参数字符串（用于增量解析）
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration?: number;
}
