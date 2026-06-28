// ============================================================================
// Auth Types
// ============================================================================

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}

export type AuthSessionTrustState = 'none' | 'cached' | 'verified';

export interface AuthStatus {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
  sessionTrustState?: AuthSessionTrustState;
  authBackendAvailable?: boolean;
  hasCachedAdminClaim?: boolean;
  /**
   * 2c(ADR-030): 曾登录但 session 不可恢复（过期/失效）→ true。
   * 用于把"默默清零"换成可见的「登录已过期，点一下重连」提示；区别于普通登出（never logged in）。
   */
  sessionExpired?: boolean;
}
