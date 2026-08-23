import type { ToolContext } from '../../../protocol/tools';

export function getFileMutationActorId(ctx: Pick<ToolContext, 'sessionId' | 'agentId'>): string | undefined {
  const agentId = ctx.agentId?.trim();
  if (!agentId) return undefined;
  return `${ctx.sessionId}:${agentId}`;
}
