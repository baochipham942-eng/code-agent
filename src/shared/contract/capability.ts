// ============================================================================
// Capability Center Types
// ============================================================================

export type CapabilityKind =
  | 'agent_engine'
  | 'skill'
  | 'mcp_template'
  | 'tool_bundle'
  | 'channel_adapter'
  | 'workflow_recipe'
  | 'connector';

export type CapabilitySourceKind =
  | 'builtin'
  | 'cloud'
  | 'curated'
  | 'local'
  | 'user'
  | 'project'
  | 'library'
  | 'team'
  | 'remote'
  | 'marketplace'
  | 'runtime'
  | 'memory'
  | 'plugin';

export type CapabilityInstallState =
  | 'available'
  | 'installed'
  | 'missing'
  | 'draft'
  | 'not_applicable';

export type CapabilityEnableState =
  | 'enabled'
  | 'disabled'
  | 'not_applicable';

export type CapabilityRuntimeState =
  | 'ready'
  | 'connected'
  | 'lazy'
  | 'disconnected'
  | 'not_configured'
  | 'blocked'
  | 'error'
  | 'unknown';

export type CapabilityRiskTier = 'low' | 'medium' | 'high';

export type CapabilityRequirementKind =
  | 'env'
  | 'secret'
  | 'binary'
  | 'path'
  | 'network'
  | 'account'
  | 'config';

export type CapabilityRequirementStatus =
  | 'met'
  | 'missing'
  | 'unknown'
  | 'not_applicable';

export interface CapabilitySourceInfo {
  kind: CapabilitySourceKind;
  label: string;
  path?: string;
  url?: string;
  version?: string;
  scope?: string;
  author?: string;
  reviewedAt?: string;
  expiresAt?: string;
  signedAt?: string;
  keyId?: string;
  signature?: string;
  contentHash?: string;
  registryFileHash?: string;
}

export interface CapabilityStateInfo {
  install: CapabilityInstallState;
  enable: CapabilityEnableState;
  runtime: CapabilityRuntimeState;
  mount?: 'mounted' | 'unmounted' | 'not_applicable';
  statusLabel?: string;
  error?: string;
}

export interface CapabilityRequirement {
  kind: CapabilityRequirementKind;
  label: string;
  value?: string;
  status: CapabilityRequirementStatus;
  sensitive?: boolean;
}

export interface CapabilityPermission {
  label: string;
  level: CapabilityRiskTier;
  detail?: string;
}

export interface CapabilityRiskInfo {
  tier: CapabilityRiskTier;
  reasons: string[];
  dataTouched?: string[];
}

export interface CapabilityAuditInfo {
  installedFiles?: string[];
  configFiles?: string[];
  rollback?: string;
  notes?: string[];
}

export interface CapabilityActionInfo {
  canEnable: boolean;
  canDisable: boolean;
  canInstallDraft?: boolean;
  canRemoveDraft?: boolean;
  reason?: string;
}

export interface CapabilityMetrics {
  tools?: number;
  resources?: number;
  prompts?: number;
  accounts?: number;
  enabledAccounts?: number;
  installedSkills?: number;
  totalSkills?: number;
}

export type CapabilityAssessmentPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type CapabilityAssessmentPortability =
  | 'native'
  | 'portable_model'
  | 'reference_only'
  | 'reject';

export interface CapabilityAssessmentInfo {
  priority: CapabilityAssessmentPriority;
  portability: CapabilityAssessmentPortability;
  recommendedUse: string;
  evidenceRefs: string[];
}

export type CapabilityInstallPlanWriteKind = 'config' | 'file';

export interface CapabilityInstallPlanWrite {
  kind: CapabilityInstallPlanWriteKind;
  target: string;
  action: 'create' | 'update';
  note?: string;
}

export interface CapabilityInstallPlan {
  mode: 'preview_only' | 'draft_config';
  title: string;
  summary: string;
  writes: CapabilityInstallPlanWrite[];
  steps: string[];
  safety: string[];
  rollback: string[];
  draft?: CapabilityInstallDraftSpec;
}

export interface CapabilityInstallDraftSpec {
  kind: 'mcp_server';
  target: 'project_mcp_json';
  name: string;
  config: Record<string, unknown>;
  parameters?: CapabilityInstallDraftParameter[];
}

export interface CapabilityInstallDraftParameter {
  key: string;
  label: string;
  kind: CapabilityRequirementKind;
  required: boolean;
  sensitive?: boolean;
  placeholder?: string;
}

export interface CapabilityCenterItem {
  id: string;
  kind: CapabilityKind;
  name: string;
  summary: string;
  description?: string;
  tags: string[];
  source: CapabilitySourceInfo;
  state: CapabilityStateInfo;
  risk: CapabilityRiskInfo;
  permissions: CapabilityPermission[];
  config: CapabilityRequirement[];
  dependencies: CapabilityRequirement[];
  audit: CapabilityAuditInfo;
  actions: CapabilityActionInfo;
  metrics?: CapabilityMetrics;
  assessment?: CapabilityAssessmentInfo;
  relatedIds?: string[];
  installPlan?: CapabilityInstallPlan;
}

export interface CapabilityCenterSummary {
  total: number;
  installed: number;
  enabled: number;
  blocked: number;
  highRisk: number;
}

export type CapabilityDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CapabilityCenterDiagnostic {
  source: 'registry';
  severity: CapabilityDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  itemId?: string;
  blocking?: boolean;
  expectedHash?: string;
  actualHash?: string;
}

export interface CapabilityCenterInventory {
  generatedAt: number;
  summary: CapabilityCenterSummary;
  items: CapabilityCenterItem[];
  diagnostics?: CapabilityCenterDiagnostic[];
}

export interface CapabilityToggleRequest {
  id: string;
  kind: CapabilityKind;
  enabled: boolean;
}

export interface CapabilityInstallDraftRequest {
  id: string;
  kind: CapabilityKind;
  inputs?: Record<string, string>;
}

export interface CapabilityRemoveDraftRequest {
  id: string;
  kind: CapabilityKind;
}
