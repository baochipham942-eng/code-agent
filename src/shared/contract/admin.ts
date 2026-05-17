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
