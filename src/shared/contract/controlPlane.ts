// ============================================================================
// Control Plane Trust Envelope
// ============================================================================

export type ControlPlaneArtifactKind =
  | 'cloud_config'
  | 'capability_registry'
  | 'agent_engine_model_catalog'
  | 'prompt_registry'
  | 'update_manifest'
  | 'runtime_assets_manifest'
  | 'renderer_bundle'
  | 'renderer_bundle_rollout';

export type ControlPlaneDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ControlPlaneEnvelope<TPayload = unknown> {
  schemaVersion: 1;
  kind: ControlPlaneArtifactKind;
  issuedAt?: string;
  expiresAt: string;
  contentHash: string;
  keyId?: string;
  signature?: string;
  payload: TPayload;
}

export interface ControlPlaneDiagnostic {
  severity: ControlPlaneDiagnosticSeverity;
  code: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ControlPlaneTrustResult<TPayload = unknown> {
  trusted: boolean;
  payload?: TPayload;
  diagnostics: ControlPlaneDiagnostic[];
  contentHash?: string;
  keyId?: string;
  expiresAt?: string;
}
