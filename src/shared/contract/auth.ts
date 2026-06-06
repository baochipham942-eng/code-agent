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
}
