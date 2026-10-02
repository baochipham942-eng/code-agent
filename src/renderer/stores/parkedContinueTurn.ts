import type { SessionStatus } from '@shared/contract';
import { isSessionActiveForStreamRecovery } from '../utils/streamRecoveryMessage';

interface ContinueProjection {
  mode: string;
  canContinue: boolean;
}

function isContinuablePark(resume: ContinueProjection | undefined): boolean {
  return resume?.mode === 'continue' && resume.canContinue;
}

/**
 * A running broadcast re-lights the turn, except when it is an older stamp
 * on a run the host already projected as continuable. That replay is what
 * flips Continue back to Stop after the user stops an auto-resumed run.
 */
export function runningBroadcastLightsTurn(input: {
  updates: { status?: string; updatedAt?: number; durableResume?: ContinueProjection };
  previous?: { updatedAt?: number; durableResume?: ContinueProjection };
}): boolean {
  if (input.updates.status !== 'running') return false;
  const resume = input.updates.durableResume ?? input.previous?.durableResume;
  if (!isContinuablePark(resume)) return true;
  const incoming = input.updates.updatedAt;
  if (typeof incoming !== 'number') return false;
  return incoming > (input.previous?.updatedAt ?? 0);
}

/** activeRun on a continuable park is a registry residue, not a live turn. */
export function recoveryLoadLightsTurn(session: {
  activeRun?: boolean;
  status?: SessionStatus;
  durableResume?: ContinueProjection;
}): boolean {
  return isSessionActiveForStreamRecovery(session) && !isContinuablePark(session.durableResume);
}

export function runtimeStatusCountsAsRunning(
  status: string,
  resume: ContinueProjection | undefined,
): boolean {
  return status === 'running' && !isContinuablePark(resume);
}

/**
 * A list refresh that is not newer than the parked Continue projection must
 * not replace it with the auto-resume row the stop already superseded.
 */
export function preserveParkedContinueOnRefresh<T extends {
  id: string;
  updatedAt?: number;
  status?: SessionStatus;
  durableResume?: ContinueProjection;
}>(current: readonly T[], incoming: readonly T[]): T[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  return incoming.map((next) => {
    const previous = currentById.get(next.id);
    if (!previous || !isContinuablePark(previous.durableResume)) return next;
    if (isContinuablePark(next.durableResume)) return next;
    if ((next.updatedAt ?? 0) > (previous.updatedAt ?? 0)) return next;
    return {
      ...next,
      durableResume: previous.durableResume,
      status: previous.status,
      updatedAt: previous.updatedAt ?? next.updatedAt,
    };
  });
}
