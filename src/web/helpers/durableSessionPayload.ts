import type { Session } from '../../shared/contract';
import {
  projectDurableRunToSessionPayload,
  type DurableRunReadService,
} from '../../host/app/durableRunReadService';

type DurableSessionPayload = Session & { durableWaitingInput?: true };

function stripDurableWaitingApprovalMarker<T extends { durableWaitingInput?: true }>(session: T): Omit<T, 'durableWaitingInput'> {
  const { durableWaitingInput: _durableWaitingApproval, ...rest } = session;
  return rest;
}

/**
 * Add the durable run projection to the session replay shape shared by REST
 * and the domain session handler. The legacy session status is only a
 * fallback when no durable row is available.
 */
export async function withDurableSessionReplayPayload<T extends Session>(
  session: T,
  readService: DurableRunReadService | undefined,
): Promise<T & { durableWaitingInput?: true }> {
  const base = stripDurableWaitingApprovalMarker(session as T & { durableWaitingInput?: true });
  if (!readService) {
    return base as T;
  }
  const run = await readService.readSessionReplay(session.id, () => ({
    status: session.status === 'running' || session.status === 'paused' ? session.status : 'idle',
    updatedAt: session.updatedAt,
  }));
  return {
    ...base,
    ...projectDurableRunToSessionPayload(run),
  } as T & { durableWaitingInput?: true };
}

export type { DurableSessionPayload };
