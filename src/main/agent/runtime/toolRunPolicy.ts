import type { ToolDefinition } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function deniedToolSet(ctx: RuntimeContext): Set<string> | null {
  const denied = (ctx.deniedToolNames || [])
    .map(normalizeToolName)
    .filter(Boolean);
  return denied.length > 0 ? new Set(denied) : null;
}

export function isToolDeniedForRun(ctx: RuntimeContext, toolName: string): boolean {
  return deniedToolSet(ctx)?.has(normalizeToolName(toolName)) ?? false;
}

export function filterToolsByRunPolicy(
  tools: ToolDefinition[],
  ctx: RuntimeContext,
): ToolDefinition[] {
  const denied = deniedToolSet(ctx);
  if (!denied) return tools;
  return tools.filter((tool) => !denied.has(normalizeToolName(tool.name)));
}
