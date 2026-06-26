// ============================================================================
// Admin Service - user dashboard and invite code management
// ============================================================================

import crypto from 'crypto';
import {
  getSupabase,
  isSupabaseInitialized,
  type Database,
} from '../infra/supabaseService';
import type {
  AdminControlPlaneAuditEventItem,
  AdminControlPlaneAuditEventListResult,
  AdminControlPlaneRolloutSummaryItem,
  AdminControlPlaneRolloutSummaryResult,
  AdminCreateInviteCodeInput,
  AdminInviteCodeItem,
  AdminInviteCodeListResult,
  AdminSetSharedRelayInput,
  AdminSetUserAdminInput,
  AdminUpdateInviteCodeInput,
  AdminUserDashboardItem,
  AdminUserDashboardResult,
} from '../../../shared/contract';

// 团队共享 provider（中转站）授权能力。授予时连同基础功能能力一起写，避免新同事拿到「只有 shared_relay
// 但没有 cloud/memory 等」的残缺 entitlement（开了按用户鉴权后，无行=fail-closed）。
const SHARED_RELAY_CAPABILITY = 'shared_relay';
const BASE_FEATURE_CAPABILITIES = [
  'cloud_agent', 'memory', 'computer_use', 'experimental_tools', 'mcp_cloud', 'mcp_server',
] as const;

type AdminUserRow = Database['public']['Functions']['admin_list_users']['Returns'][number];
type InviteCodeRow = Database['public']['Functions']['admin_list_invite_codes']['Returns'][number];
type ControlPlaneAuditEventRow =
  Database['public']['Functions']['admin_list_control_plane_audit_events']['Returns'][number];
type ControlPlaneRolloutSummaryRow =
  Database['public']['Functions']['admin_control_plane_rollout_summary']['Returns'][number];

function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function generateInviteCode(): string {
  return `CA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function normalizeDate(value: string | null | undefined): string | undefined {
  return value || undefined;
}

function toUserDashboardItem(row: AdminUserRow): AdminUserDashboardItem {
  return {
    id: row.id,
    email: row.email,
    username: row.username || undefined,
    nickname: row.nickname || undefined,
    avatarUrl: row.avatar_url || undefined,
    isAdmin: row.is_admin,
    status: row.status || 'active',
    signupSource: row.signup_source || undefined,
    inviteCode: row.invite_code || undefined,
    provider: row.provider || undefined,
    createdAt: row.created_at,
    lastSignInAt: normalizeDate(row.last_sign_in_at),
    lastActiveAt: normalizeDate(row.last_active_at),
    lastSyncAt: normalizeDate(row.last_sync_at),
    lastSessionUpdatedAt: row.last_session_updated_at || undefined,
    deviceCount: Number(row.device_count || 0),
    sessionCount: Number(row.session_count || 0),
    messageCount: Number(row.message_count || 0),
  };
}

function toInviteCodeItem(row: InviteCodeRow): AdminInviteCodeItem {
  const remainingUses = Math.max(Number(row.max_uses || 0) - Number(row.use_count || 0), 0);
  return {
    id: row.id,
    code: row.code,
    label: row.label || undefined,
    maxUses: Number(row.max_uses || 0),
    useCount: Number(row.use_count || 0),
    remainingUses,
    expiresAt: normalizeDate(row.expires_at),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: normalizeDate(row.updated_at),
    lastUsedAt: normalizeDate(row.last_used_at),
    createdBy: row.created_by || undefined,
    createdByEmail: row.created_by_email || undefined,
  };
}

function toControlPlaneAuditEventItem(row: ControlPlaneAuditEventRow): AdminControlPlaneAuditEventItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    artifactKind: row.artifact_kind,
    payloadVersion: normalizeDate(row.payload_version),
    releaseChannel: row.release_channel || undefined,
    keyId: normalizeDate(row.key_id),
    contentHash: normalizeDate(row.content_hash),
    outcome: row.outcome,
    statusCode: Number(row.status_code || 0),
    errorCode: normalizeDate(row.error_code),
    subjectId: normalizeDate(row.subject_id),
    subjectSource: normalizeDate(row.subject_source),
    entitlementStatus: normalizeDate(row.entitlement_status),
    entitlementPlan: normalizeDate(row.entitlement_plan),
    entitlementReason: normalizeDate(row.entitlement_reason),
  };
}

function toControlPlaneRolloutSummaryItem(row: ControlPlaneRolloutSummaryRow): AdminControlPlaneRolloutSummaryItem {
  return {
    artifactKind: row.artifact_kind,
    payloadVersion: normalizeDate(row.payload_version),
    releaseChannel: row.release_channel || undefined,
    keyId: normalizeDate(row.key_id),
    contentHash: normalizeDate(row.content_hash),
    lastSeenAt: normalizeDate(row.last_seen_at),
    servedCount: Number(row.served_count || 0),
    errorCount: Number(row.error_count || 0),
  };
}

class AdminService {
  async listUsers(): Promise<AdminUserDashboardResult> {
    if (!isSupabaseInitialized()) {
      return { users: [], unavailableReason: 'Supabase not initialized' };
    }

    const { data, error } = await getSupabase().rpc('admin_list_users', {});
    if (error) {
      throw new Error(error.message);
    }

    const sharedRelayIds = await this.fetchSharedRelayUserIds();
    return {
      users: (data || []).map((row) => {
        const item = toUserDashboardItem(row);
        item.hasSharedRelay = sharedRelayIds.has(item.id);
        return item;
      }),
    };
  }

  /** 拿到「有团队共享 provider 权限」的 user_id 集合（capabilities 含 shared_relay 或 *）。admin RLS 允许读全表。 */
  private async fetchSharedRelayUserIds(): Promise<Set<string>> {
    const { data, error } = await getSupabase()
      .from('control_plane_entitlements')
      .select('user_id,capabilities');
    if (error || !data) {
      return new Set<string>();
    }
    const ids = new Set<string>();
    for (const row of data) {
      const caps = row.capabilities ?? [];
      if (caps.includes(SHARED_RELAY_CAPABILITY) || caps.includes('*')) {
        ids.add(row.user_id);
      }
    }
    return ids;
  }

  /** 给某用户开/关团队共享 key。开=补齐基础功能+shared_relay；关=去掉 shared_relay 保留基础功能。 */
  async setUserSharedRelay(input: AdminSetSharedRelayInput): Promise<AdminUserDashboardResult> {
    if (!isSupabaseInitialized()) {
      return { users: [], unavailableReason: 'Supabase not initialized' };
    }
    const supabase = getSupabase();
    const { data: existing } = await supabase
      .from('control_plane_entitlements')
      .select('capabilities,plan')
      .eq('user_id', input.userId)
      .maybeSingle();

    const caps = new Set(existing?.capabilities ?? []);
    if (input.enabled) {
      for (const cap of BASE_FEATURE_CAPABILITIES) caps.add(cap);
      caps.add(SHARED_RELAY_CAPABILITY);
    } else {
      caps.delete(SHARED_RELAY_CAPABILITY);
    }

    const { error } = await supabase
      .from('control_plane_entitlements')
      .upsert({
        user_id: input.userId,
        status: 'active',
        plan: existing?.plan && existing.plan !== 'free' ? existing.plan : 'team',
        capabilities: Array.from(caps),
      }, { onConflict: 'user_id' });
    if (error) {
      throw new Error(error.message);
    }

    return this.listUsers();
  }

  /** 给某用户开/关管理员角色。实际写入由数据库 SECURITY DEFINER RPC 执行，避免客户端绕过 RLS。 */
  async setUserAdmin(input: AdminSetUserAdminInput): Promise<AdminUserDashboardResult> {
    if (!isSupabaseInitialized()) {
      return { users: [], unavailableReason: 'Supabase not initialized' };
    }

    const { error } = await getSupabase().rpc('admin_set_user_admin', {
      p_user_id: input.userId,
      p_is_admin: input.enabled,
    });
    if (error) {
      throw new Error(error.message);
    }

    return this.listUsers();
  }

  async listInviteCodes(): Promise<AdminInviteCodeListResult> {
    if (!isSupabaseInitialized()) {
      return { inviteCodes: [], unavailableReason: 'Supabase not initialized' };
    }

    const { data, error } = await getSupabase().rpc('admin_list_invite_codes', {});
    if (error) {
      throw new Error(error.message);
    }

    return { inviteCodes: (data || []).map(toInviteCodeItem) };
  }

  async createInviteCode(input: AdminCreateInviteCodeInput): Promise<AdminInviteCodeListResult> {
    if (!isSupabaseInitialized()) {
      return { inviteCodes: [], unavailableReason: 'Supabase not initialized' };
    }

    const code = normalizeInviteCode(input.code || generateInviteCode());
    const maxUses = Math.max(Math.floor(input.maxUses || 1), 1);
    const { error } = await getSupabase().rpc('admin_create_invite_code', {
      p_code: code,
      p_max_uses: maxUses,
      p_expires_at: input.expiresAt || null,
      p_label: input.label?.trim() || null,
    });

    if (error) {
      throw new Error(error.message);
    }

    return this.listInviteCodes();
  }

  async updateInviteCode(input: AdminUpdateInviteCodeInput): Promise<AdminInviteCodeListResult> {
    if (!isSupabaseInitialized()) {
      return { inviteCodes: [], unavailableReason: 'Supabase not initialized' };
    }

    const { error } = await getSupabase().rpc('admin_update_invite_code', {
      p_id: input.id,
      p_label: input.label === null ? '' : input.label ?? null,
      p_max_uses: input.maxUses ?? null,
      p_expires_at: input.expiresAt ?? null,
      p_is_active: input.isActive ?? null,
    });

    if (error) {
      throw new Error(error.message);
    }

    return this.listInviteCodes();
  }

  async listControlPlaneAuditEvents(limit = 50): Promise<AdminControlPlaneAuditEventListResult> {
    if (!isSupabaseInitialized()) {
      return { events: [], unavailableReason: 'Supabase not initialized' };
    }

    const normalizedLimit = Math.max(Math.min(Math.floor(limit || 50), 200), 1);
    const { data, error } = await getSupabase().rpc('admin_list_control_plane_audit_events', {
      p_limit: normalizedLimit,
    });
    if (error) {
      return { events: [], unavailableReason: error.message };
    }

    return { events: (data || []).map(toControlPlaneAuditEventItem) };
  }

  async listControlPlaneRolloutSummary(): Promise<AdminControlPlaneRolloutSummaryResult> {
    if (!isSupabaseInitialized()) {
      return { items: [], unavailableReason: 'Supabase not initialized' };
    }

    const { data, error } = await getSupabase().rpc('admin_control_plane_rollout_summary', {});
    if (error) {
      return { items: [], unavailableReason: error.message };
    }

    return { items: (data || []).map(toControlPlaneRolloutSummaryItem) };
  }
}

let adminServiceInstance: AdminService | null = null;

export function getAdminService(): AdminService {
  if (!adminServiceInstance) {
    adminServiceInstance = new AdminService();
  }
  return adminServiceInstance;
}

export type { AdminService };
