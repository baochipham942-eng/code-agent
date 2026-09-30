import type { ToolCall } from '../../../shared/contract';
import type { MCPToolAnnotations } from '../../mcp/types';
import type { ToolSchema } from '../../protocol/tools';
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import {
  type ResolvedToolAccess,
} from '../../security/resourceScope';
import { resolveFoldedToolAccess } from '../../security/toolAccessResolve';
import { getProtocolRegistry } from '../protocolRegistry';
import { getProtocolToolSchemas } from '../protocolToolRegistration';
import { isBashToolName } from '../toolNames';
import { foldToolAccess } from './foldToolAccess';

const BARRIER_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'confirm_action',
  'exit_plan_mode',
  'attempt_completion',
]);

const UNKNOWN_READWRITE: ResolvedToolAccess = { kind: 'readwrite', domain: { type: 'unknown' } };

export interface ResolveToolCallAccessOptions {
  readonly workspace: string;
  readonly cwd: string;
  readonly mcpAnnotations?: Map<string, MCPToolAnnotations>;
}

function builtinSchemas(): readonly ToolSchema[] {
  const fromPort = getProtocolToolSchemas();
  if (fromPort.length > 0) return fromPort;
  try {
    const schemas = getProtocolRegistry()?.getSchemas?.() ?? [];
    return schemas.length > 0 ? schemas : fromPort;
  } catch {
    return fromPort;
  }
}

function findBuiltinSchema(schemas: readonly ToolSchema[], requested: string): ToolSchema | undefined {
  const aliased = resolveToolAlias(requested);
  return schemas.find((schema) => {
    if (schema.name === requested || schema.name === aliased) return true;
    if (schema.aliases?.some((alias) => alias === requested || alias === aliased)) return true;
    return isBashToolName(requested) && isBashToolName(schema.name);
  });
}

function orUnknown(resolved: readonly ResolvedToolAccess[]): ResolvedToolAccess[] {
  return resolved.length > 0 ? [...resolved] : [UNKNOWN_READWRITE];
}

/** 内置 schema 优先于 mcp_ 前缀。读/写只看折叠结果，不看工具名字。 */
export function resolveToolCallAccesses(
  toolCall: ToolCall,
  options: ResolveToolCallAccessOptions,
): ResolvedToolAccess[] {
  const schema = findBuiltinSchema(builtinSchemas(), toolCall.name);
  if (schema) {
    const folded = foldToolAccess({
      accesses: schema.accesses,
      readOnly: schema.readOnly,
      pathAuthority: schema.pathAuthority,
      emission: schema.emission,
    });
    return orUnknown(resolveFoldedToolAccess({
      toolName: schema.name,
      folded,
      params: toolCall.arguments ?? {},
      workspace: options.workspace,
      cwd: options.cwd,
    }));
  }
  if (toolCall.name.startsWith('mcp_')) {
    const folded = foldToolAccess({
      mcpTool: true,
      mcpAnnotations: options.mcpAnnotations?.get(toolCall.name),
    });
    return orUnknown(resolveFoldedToolAccess({
      toolName: toolCall.name,
      folded,
      params: toolCall.arguments ?? {},
      workspace: options.workspace,
      cwd: options.cwd,
    }));
  }
  return [UNKNOWN_READWRITE];
}

/** 屏障按规范名识别。PlanMode 只有 action 为 exit 时才是屏障。 */
export function isBarrierToolCall(toolCall: ToolCall): boolean {
  const schema = findBuiltinSchema(builtinSchemas(), toolCall.name);
  const canonical = schema?.name ?? resolveToolAlias(toolCall.name);
  if (canonical === 'PlanMode') return toolCall.arguments?.action === 'exit';
  return BARRIER_TOOL_NAMES.has(canonical);
}
