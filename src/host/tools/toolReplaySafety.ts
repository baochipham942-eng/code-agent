import type { ToolDefinition, ToolReplaySafety } from '../../shared/contract';
import type { MCPToolAnnotations } from '../mcp/types';
import { classifyMcpToolReplaySafety } from '../mcp/mcpToolSafety';
import { isExternalSideEffectTool } from './externalSideEffect';

type MCPDefinitionMetadata = {
  metadata?: { annotations?: MCPToolAnnotations };
};

function isMcpDefinition(definition: ToolDefinition): boolean {
  return definition.name.startsWith('mcp__') || definition.name.startsWith('mcp_');
}

/** Mirrors the native durable checkpoint's existing write-side-effect fold. */
export function hasNativeToolSideEffect(definition: ToolDefinition): boolean {
  return definition.permissionLevel !== 'read'
    && !(definition.permissionLevel === 'network' && definition.readOnly === true);
}

/**
 * One replay classifier for native and MCP tools. It derives from declarations
 * already carried by ToolDefinition; no replay field is added to tool schemas.
 */
export function classifyToolReplaySafety(
  definition: ToolDefinition | undefined,
): ToolReplaySafety {
  if (!definition) return 'unknown';
  if (isExternalSideEffectTool(definition.name)) return 'forbidden';
  if (isMcpDefinition(definition)) {
    const annotations = (definition as ToolDefinition & MCPDefinitionMetadata).metadata?.annotations;
    return classifyMcpToolReplaySafety(annotations);
  }
  if (definition.readOnly === true && !hasNativeToolSideEffect(definition)) {
    return 'automatic';
  }
  return 'unknown';
}

/** pi §4.5: both the persisted and current declarations must still be safe. */
export function canAutomaticallyReplayTool(
  stored: ToolReplaySafety | null | undefined,
  current: ToolReplaySafety,
): boolean {
  return stored === 'automatic' && current === 'automatic';
}
