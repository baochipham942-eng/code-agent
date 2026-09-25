export const JOURNEY_IDS = ['cold-start', 'first-token', 'long-session', 'session-switch'] as const;

export type JourneyId = (typeof JOURNEY_IDS)[number];

export interface JourneyLongTask {
  name: string;
  startTime: number;
  duration: number;
}

export interface JourneyProbeResult {
  schemaVersion: 1;
  journey: JourneyId;
  /** Gated deterministic metric: React Profiler commit count for the journey subtree. */
  commitCount: number;
  /** Recorded for diagnosis; gated only when a journey proves it is byte-stable. */
  hotRenderCount: number;
  /** Recorded only. Never a gate. */
  wallClockMs: number;
  /** Recorded only. Long tasks are not deterministic. */
  longTaskCount: number;
  longTaskMaxMs: number;
  extraRenders: number;
  ready: Record<string, unknown>;
}

export function isJourneyId(value: string): value is JourneyId {
  return (JOURNEY_IDS as readonly string[]).includes(value);
}

export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
