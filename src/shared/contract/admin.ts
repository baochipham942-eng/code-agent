// ============================================================================
// Admin / Operations Management Types
// ============================================================================

export interface AdminUserDashboardItem {
  id: string;
  email: string;
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  isAdmin: boolean;
  status: 'active' | 'suspended' | 'deleted';
  signupSource?: string;
  inviteCode?: string;
  provider?: string;
  createdAt: string;
  lastSignInAt?: string;
  lastActiveAt?: string;
  lastSyncAt?: string;
  lastSessionUpdatedAt?: number;
  deviceCount: number;
  sessionCount: number;
  messageCount: number;
}

export interface AdminUserDashboardResult {
  users: AdminUserDashboardItem[];
  unavailableReason?: string;
}

export interface AdminInviteCodeItem {
  id: string;
  code: string;
  label?: string;
  maxUses: number;
  useCount: number;
  remainingUses: number;
  expiresAt?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
  createdBy?: string;
  createdByEmail?: string;
}

export interface AdminInviteCodeListResult {
  inviteCodes: AdminInviteCodeItem[];
  unavailableReason?: string;
}

export interface AdminCreateInviteCodeInput {
  code?: string;
  label?: string;
  maxUses: number;
  expiresAt?: string | null;
}

export interface AdminUpdateInviteCodeInput {
  id: string;
  label?: string | null;
  maxUses?: number;
  expiresAt?: string | null;
  isActive?: boolean;
}

export interface AdminControlPlaneAuditEventItem {
  id: string;
  createdAt: string;
  artifactKind: 'cloud_config' | 'capability_registry' | 'agent_engine_model_catalog' | 'prompt_registry' | 'update_manifest';
  payloadVersion?: string;
  releaseChannel?: 'stable' | 'beta' | 'canary';
  keyId?: string;
  contentHash?: string;
  outcome: 'served' | 'not_modified' | 'head' | 'error';
  statusCode: number;
  errorCode?: string;
  subjectId?: string;
  subjectSource?: string;
  entitlementStatus?: string;
  entitlementPlan?: string;
  entitlementReason?: string;
}

export interface AdminControlPlaneAuditEventListResult {
  events: AdminControlPlaneAuditEventItem[];
  unavailableReason?: string;
}

export interface AdminControlPlaneRolloutSummaryItem {
  artifactKind: AdminControlPlaneAuditEventItem['artifactKind'];
  payloadVersion?: string;
  releaseChannel?: AdminControlPlaneAuditEventItem['releaseChannel'];
  keyId?: string;
  contentHash?: string;
  lastSeenAt?: string;
  servedCount: number;
  errorCount: number;
}

export interface AdminControlPlaneRolloutSummaryResult {
  items: AdminControlPlaneRolloutSummaryItem[];
  unavailableReason?: string;
}
