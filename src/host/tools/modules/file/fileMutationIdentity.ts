import type { ToolContext } from '../../../protocol/tools';

export function getFileMutationActorId(ctx: ToolContext): string | undefined {
  const agentId = ctx.agentId?.trim();
  if (!agentId) return undefined;
  return `${ctx.sessionId}:${agentId}`;
}
