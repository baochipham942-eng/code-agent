// ============================================================================
// Activity Provider Contract
// Shared vocabulary for screen memory and desktop activity sources.
// ============================================================================

export type ActivityProviderKind = 'bundled' | 'sidecar' | 'daemon';

export type ActivityCaptureSource =
  | 'automatic-screen-memory'
  | 'manual-desktop-session'
  | 'meeting-audio'
  | 'screenshot-analysis'
  | 'workspace-activity'
  | 'planning-recovery';

export type ActivityProviderState =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'available'
  | 'unavailable'
  | 'error';

export interface ActivityProviderDescriptor {
  id: string;
  label: string;
  kind: ActivityProviderKind;
  state: ActivityProviderState;
  captureSources: ActivityCaptureSource[];
  lifecycle: 'app-scoped' | 'session-scoped' | 'always-on';
  contextRole: 'automatic-background' | 'manual-scene-capture' | 'derived-context';
  privacyBoundary: 'provider-filtered' | 'injection-filtered' | 'manual-only';
  summary: string;
  detail?: string;
  lastActivityAtMs?: number | null;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ActivityProviderListResult {
  generatedAtMs: number;
  providers: ActivityProviderDescriptor[];
}
