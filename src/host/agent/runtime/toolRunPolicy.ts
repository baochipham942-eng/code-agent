import type { ToolDefinition } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import { ASK_USER_QUESTION_TOOL_NAMES } from '../../../shared/constants/tools';
import { createLogger } from '../../services/infra/logger';
import { trackNode } from '../../observability/posthogNode';
import { POSTHOG_EVENTS } from '../../../shared/observability/posthog-events';

const logger = createLogger('AgentLoop');

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function deniedToolSet(ctx: RuntimeContext): Set<string> | null {
  const denied = (ctx.deniedToolNames || [])
    .map(normalizeToolName)
    .filter(Boolean);
  return denied.length > 0 ? new Set(denied) : null;
}

function allowedToolSet(ctx: RuntimeContext): Set<string> | null {
  const allowed = (ctx.allowedToolNames || [])
    .map(normalizeToolName)
    .filter(Boolean);
  return allowed.length > 0 ? new Set(allowed) : null;
}

export function isToolDeniedForRun(ctx: RuntimeContext, toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  const allowed = allowedToolSet(ctx);
  return (allowed ? !allowed.has(normalized) : false)
    || (deniedToolSet(ctx)?.has(normalized) ?? false);
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
  const allowed = allowedToolSet(ctx);
  if (!denied && !allowed) return tools;
  return tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name);
    return allowed?.has(normalized) !== false && denied?.has(normalized) !== true;
  });
}

/**
 * filterToolsByRunPolicy + 收窄可观测性。与 contextAssembly/inference.ts 里 A6
 * （strict_skill）/A8（artifact_repair）的日志 + TOOL_SCOPE_NARROWED 遥测对齐——
 * 之前 allowlist/denylist 收窄（如会话指挥台前台 brain）既不打日志也不发遥测，
 * 排查时无法定位收窄发生在哪一步（2026-08-07 T3 工具坍缩排查报告 §6）。
 * 就近放在 toolRunPolicy.ts 而非内联进 inference.ts，避免把后者推过 max-lines 门。
 */
export function filterToolsByRunPolicyObserved(
  tools: ToolDefinition[],
  ctx: RuntimeContext,
): ToolDefinition[] {
  const before = tools.length;
  const filtered = filterToolsByRunPolicy(tools, ctx);
  if (filtered.length !== before) {
    logger.info(
      `[AgentLoop] Run policy toolset: tool list narrowed ${before} -> ${filtered.length}`,
    );
    trackNode(POSTHOG_EVENTS.TOOL_SCOPE_NARROWED, {
      sessionId: ctx.sessionId,
      narrowedBy: 'run_policy',
      before,
      after: filtered.length,
    });
  }
  return filtered;
}
