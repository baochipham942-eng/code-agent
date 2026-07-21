import type { InteractiveSurfaceSessionV1 } from '../../../shared/contract/surfaceExecution';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import type { SurfaceEventHub } from './SurfaceEventHub';

export function publishSurfaceContinuationEvent(
  events: SurfaceEventHub,
  session: InteractiveSurfaceSessionV1,
  subject: SurfaceGrantSubjectV1,
): void {
  events.publish(subject, {
    phase: 'recover',
    status: 'succeeded',
    userSummary: 'Continued from a read-only Surface checkpoint; a fresh observation is required.',
    operation: {
      action: 'continue_from_checkpoint',
      risk: 'control',
      expectedOutcome: 'Observe the current target before sending a new mutation.',
    },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    completedAt: Date.now(),
  });
}
