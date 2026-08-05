import type { ToolDefinition } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import { ASK_USER_QUESTION_TOOL_NAMES } from '../../../shared/constants/tools';

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

export function deniedToolRetryGuidance(ctx: RuntimeContext): string {
  const askDenied = ASK_USER_QUESTION_TOOL_NAMES.some((name) => isToolDeniedForRun(ctx, name));
  return askDenied
    ? 'Continue without those tools. If you need user input, state the blocker in your final text instead of calling an interactive tool.'
    : 'Continue without those tools. AskUserQuestion remains available; call it directly when the current task requires user input.';
}

export function filterToolsByRunPolicy(
  tools: ToolDefinition[],
  ctx: RuntimeContext,
): ToolDefinition[] {
  const denied = deniedToolSet(ctx);
  if (!denied) return tools;
  return tools.filter((tool) => !denied.has(normalizeToolName(tool.name)));
}
