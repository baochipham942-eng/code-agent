import type { ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import { projectSessionCandidates } from '../../../services/delegation/delegationCandidates';
import { isCrossSessionDelegationEnabled } from '../../../services/delegation/crossSessionDelegationFlag';
import { getDelegationCandidateSecret, getDelegationToolRuntime } from '../../../services/delegation/delegationToolRuntime';
import { listSessionCandidatesSchema as schema } from './listSessionCandidates.schema';

export function featureDisabled(): ToolResult<string> {
  return { ok: false, code: 'FEATURE_DISABLED', error: 'cross-session delegation is disabled' };
}

export async function executeListSessionCandidates(
  _args: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1],
  canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
): Promise<ToolResult<string>> {
  if (!isCrossSessionDelegationEnabled()) return featureDisabled();
  const permission = await canUseTool(schema.name, {});
  if (!permission.allow) return { ok: false, code: 'PERMISSION_DENIED', error: permission.reason };
  const runtime = getDelegationToolRuntime();
  try {
    const projection = projectSessionCandidates(runtime.listSessions(), {
      originSessionId: ctx.sessionId,
      now: runtime.now(),
      secret: getDelegationCandidateSecret(),
      isRunning: (sessionId) => runtime.getRun(sessionId) !== undefined,
    });
    return {
      ok: true,
      output: JSON.stringify({ candidateSetId: projection.candidateSetId, candidates: projection.candidates }),
      meta: { candidateSetId: projection.candidateSetId, candidates: projection.candidates },
    };
  } catch {
    return {
      ok: false,
      code: 'DELEGATION_REJECTED',
      error: 'ambiguous: candidate sessions could not be read. Nothing was delegated. Ask the user with AskUserQuestion; do not retry with create_new.',
    };
  }
}

class ListSessionCandidatesHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(...args: Parameters<ToolHandler<Record<string, unknown>, string>['execute']>) {
    return executeListSessionCandidates(...args);
  }
}

export const listSessionCandidatesModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new ListSessionCandidatesHandler(),
};
