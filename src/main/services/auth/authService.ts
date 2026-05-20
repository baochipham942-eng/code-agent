// ============================================================================
// Auth Service
// Handles user authentication with Supabase
// ============================================================================

import { shell } from '../../platform';
import crypto from 'crypto';
import {
  getSupabase,
  isSupabaseInitialized,
  type ProfileRow,
  type InviteCodeRow,
} from '../infra/supabaseService';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { getSecureStorage } from '../core';
import type { AuthUser, AuthStatus } from '../../../shared/contract';
import { createLogger } from '../infra/logger';
import { withTimeout } from '../infra/timeoutController';

const logger = createLogger('AuthService');

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

type AuthChangeCallback = (user: AuthUser | null) => void;
type SessionTrustState = 'none' | 'cached' | 'verified';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isUnknownRecord(value)) return undefined;
  return optionalString(value[key]);
}

function parseCachedAuthUser(serializedUser: string): AuthUser | null {
  const parsed: unknown = JSON.parse(serializedUser);
  if (!isUnknownRecord(parsed)) {
    return null;
  }

  if (typeof parsed.id !== 'string' || typeof parsed.email !== 'string') {
    return null;
  }

  return {
    id: parsed.id,
    email: parsed.email,
    username: optionalString(parsed.username),
    nickname: optionalString(parsed.nickname),
    avatarUrl: optionalString(parsed.avatarUrl),
    isAdmin: optionalBoolean(parsed.isAdmin),
  };
}

class AuthService {
  private currentUser: AuthUser | null = null;
  private sessionTrustState: SessionTrustState = 'none';
  private onAuthChangeCallbacks: AuthChangeCallback[] = [];
  private initialized: boolean = false;

  constructor() {}

  addAuthChangeCallback(callback: AuthChangeCallback): () => void {
    this.onAuthChangeCallbacks.push(callback);
    return () => {
      const index = this.onAuthChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.onAuthChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyAuthChange(user: AuthUser | null): void {
    const publicUser = this.getPublicUserForCurrentTrust(user);
    this.onAuthChangeCallbacks.forEach((callback) => {
      try {
        callback(publicUser);
      } catch (err) {
        logger.error('Auth change callback error:', err);
      }
    });
  }

  private getPublicUserForCurrentTrust(user: AuthUser | null): AuthUser | null {
    if (!user) return null;
    if (this.hasVerifiedSession()) return user;
    if (user.isAdmin !== true) return user;
    return {
      ...user,
      isAdmin: false,
    };
  }

  async initialize(): Promise<void> {
    logger.info(' initialize() called');
    if (this.initialized) {
      logger.info(' Already initialized');
      return;
    }

    // 1. 先从本地缓存读取用户信息，立即展示（无网络延迟）
    const cachedUser = this.loadCachedUser();
    if (cachedUser) {
      logger.info(' Loaded cached user:', cachedUser.email);
      this.currentUser = cachedUser;
      this.sessionTrustState = 'cached';
      this.notifyAuthChange(cachedUser);
    }

    if (!isSupabaseInitialized()) {
      logger.info(' Supabase not ready, using cached user only');
      this.initialized = true;
      return;
    }

    const supabase = getSupabase();
    logger.info(' Got Supabase client');

    // Listen for auth state changes
    supabase.auth.onAuthStateChange(async (event, session) => {
      logger.info(' Auth state changed:', event);

      if (session?.user) {
        logger.info(' Fetching user profile in callback...');
        this.currentUser = await this.fetchUserProfile(session.user);
        this.sessionTrustState = 'verified';
        this.cacheUser(this.currentUser); // 缓存用户信息
        logger.info(' Profile fetched in callback');
        this.notifyAuthChange(this.currentUser);
      } else {
        this.currentUser = null;
        this.sessionTrustState = 'none';
        this.clearCachedUser();
        this.notifyAuthChange(null);
      }
    });
    logger.info(' Auth state change listener registered');

    // 2. 后台验证 session 有效性（不阻塞 UI）
    logger.info(' Validating session in background...');
    this.validateSessionInBackground();

    this.initialized = true;
    logger.info(' Initialization complete');
  }

  /**
   * 后台验证 session，不阻塞启动
   */
  private async validateSessionInBackground(): Promise<void> {
    try {
      const supabase = getSupabase();
      // withTimeout 自动清理 timer，避免胜者侧 leak
      const result = (await withTimeout(
        supabase.auth.getSession(),
        5000,
        'Session fetch timeout',
      )) as { data: { session: { user?: SupabaseUser } | null } } | null;
      const session = result?.data?.session;
      logger.info(' Background validation result:', session ? 'valid' : 'invalid');

      if (session?.user) {
        // Session 有效，更新用户信息
        const freshUser = await this.fetchUserProfile(session.user);
        this.currentUser = freshUser;
        this.sessionTrustState = 'verified';
        this.cacheUser(freshUser);
        this.notifyAuthChange(freshUser);
      } else if (this.currentUser) {
        // Session 无效但有缓存用户，清除
        logger.info(' Session invalid, clearing cached user');
        this.currentUser = null;
        this.sessionTrustState = 'none';
        this.clearCachedUser();
        this.notifyAuthChange(null);
      }
    } catch (error) {
      logger.warn(' Background session validation failed:', error);
      // 网络错误时保持缓存用户，不清除
    }
  }

  /**
   * 缓存用户信息到本地存储
   */
  private cacheUser(user: AuthUser): void {
    try {
      const storage = getSecureStorage();
      storage.set('auth.user', JSON.stringify(user));
    } catch (e) {
      logger.error(' Failed to cache user:', e);
    }
  }

  /**
   * 从本地存储读取缓存的用户信息
   */
  private loadCachedUser(): AuthUser | null {
    try {
      const storage = getSecureStorage();
      const userJson = storage.get('auth.user');
      if (userJson) {
        return parseCachedAuthUser(userJson);
      }
    } catch (e) {
      logger.error(' Failed to load cached user:', e);
    }
    return null;
  }

  /**
   * 清除缓存的用户信息
   */
  private clearCachedUser(): void {
    try {
      const storage = getSecureStorage();
      storage.delete('auth.user');
    } catch (e) {
      logger.error(' Failed to clear cached user:', e);
    }
  }

  async getStatus(): Promise<AuthStatus> {
    return {
      isAuthenticated: this.currentUser !== null,
      user: this.getPublicUserForCurrentTrust(this.currentUser),
      isLoading: false,
    };
  }

  /**
   * 获取当前 session 的 access token（用于云端 API 调用）
   */
  async getAccessToken(): Promise<string | null> {
    if (!isSupabaseInitialized()) {
      return null;
    }

    try {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token || null;
    } catch (error) {
      logger.error('Failed to get access token:', error);
      return null;
    }
  }

  async signInWithEmail(email: string, password: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (data.user) {
      await this.touchUserLastActive(data.user.id);
      this.currentUser = await this.fetchUserProfile(data.user);
      this.sessionTrustState = 'verified';
      this.cacheUser(this.currentUser); // 缓存用户信息
      return { success: true, user: this.currentUser };
    }

    return { success: false, error: 'Unknown error' };
  }

  async signUpWithEmail(
    email: string,
    password: string,
    inviteCode?: string
  ): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const normalizedInviteCode = inviteCode?.trim().toUpperCase();

    // Validate invite code if provided
    if (normalizedInviteCode) {
      const { data: codeDataRaw, error: codeError } = await supabase
        .from('invite_codes')
        .select('*')
        .eq('code', normalizedInviteCode)
        .eq('is_active', true)
        .single();

      const codeData = codeDataRaw as InviteCodeRow | null;

      if (codeError || !codeData) {
        return { success: false, error: '无效的邀请码' };
      }

      if (codeData.use_count >= codeData.max_uses) {
        return { success: false, error: '邀请码已用完' };
      }

      if (codeData.expires_at && new Date(codeData.expires_at) < new Date()) {
        return { success: false, error: '邀请码已过期' };
      }
    } else {
      // Invite code required
      return { success: false, error: '需要邀请码才能注册' };
    }

    // Sign up
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (data.user) {
      // Update invite code usage
      if (normalizedInviteCode) {
        await supabase.rpc('increment_invite_code_usage', {
          code_value: normalizedInviteCode,
        });
      }

      // Create profile
      await supabase.from('profiles').upsert({
        id: data.user.id,
        username: email.split('@')[0],
        quick_login_token: crypto.randomBytes(32).toString('hex'),
        signup_source: 'invite_code',
        invite_code: normalizedInviteCode,
        last_active_at: new Date().toISOString(),
      }, { onConflict: 'id' });

      this.currentUser = await this.fetchUserProfile(data.user);
      this.sessionTrustState = 'verified';
      this.cacheUser(this.currentUser); // 缓存用户信息
      return { success: true, user: this.currentUser };
    }

    return { success: false, error: 'Unknown error' };
  }

  async signInWithOAuth(provider: 'github' | 'google'): Promise<void> {
    if (!isSupabaseInitialized()) {
      throw new Error('Supabase not initialized');
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: 'code-agent://auth/callback',
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      throw error;
    }

    if (data.url) {
      await shell.openExternal(data.url);
    }
  }

  async handleOAuthCallback(code: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return { success: false, error: error.message };
    }

    if (data.user) {
      // Ensure profile exists
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .single();

      if (!profile) {
        const provider = typeof data.user.app_metadata?.provider === 'string'
          ? data.user.app_metadata.provider
          : 'oauth';
        const nickname = readStringProperty(data.user.user_metadata, 'full_name');
        const avatarUrl = readStringProperty(data.user.user_metadata, 'avatar_url');
        await supabase.from('profiles').insert({
          id: data.user.id,
          username: data.user.email?.split('@')[0] || data.user.id,
          nickname,
          avatar_url: avatarUrl,
          quick_login_token: crypto.randomBytes(32).toString('hex'),
          signup_source: provider,
          last_active_at: new Date().toISOString(),
        });
      } else {
        await this.touchUserLastActive(data.user.id);
      }

      this.currentUser = await this.fetchUserProfile(data.user);
      this.sessionTrustState = 'verified';
      this.cacheUser(this.currentUser); // 缓存用户信息
      return { success: true, user: this.currentUser };
    }

    return { success: false, error: 'Unknown error' };
  }

  async signInWithQuickToken(token: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();

    // Find user by quick login token
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('quick_login_token', token)
      .single();

    if (profileError || !profile) {
      return { success: false, error: '无效的快捷登录 Token' };
    }

    // Get user email from auth.users (via admin API or stored in profile)
    // Note: This requires storing email in profiles or using admin API
    // For now, we'll return an error indicating this feature needs server-side support
    return {
      success: false,
      error: '快捷登录需要服务端支持，请使用邮箱密码登录',
    };
  }

  async signOut(): Promise<void> {
    try {
      if (isSupabaseInitialized()) {
        await getSupabase().auth.signOut();
      }
    } finally {
      const storage = getSecureStorage();
      await storage.clearSessionFromKeychain(); // Also clear from Keychain
      storage.clearAuthData();
      this.currentUser = null;
      this.sessionTrustState = 'none';
      this.notifyAuthChange(null);
    }
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  hasVerifiedSession(): boolean {
    return this.currentUser !== null && this.sessionTrustState === 'verified';
  }

  getSessionTrustState(): SessionTrustState {
    return this.sessionTrustState;
  }

  private async touchUserLastActive(userId: string): Promise<void> {
    if (!isSupabaseInitialized()) return;
    try {
      await getSupabase()
        .from('profiles')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', userId);
    } catch (error) {
      logger.debug('Failed to update last active timestamp:', error);
    }
  }

  // Clear current user without calling Supabase signOut (used when clearing cache)
  clearCurrentUser(): void {
    this.currentUser = null;
    this.sessionTrustState = 'none';
    this.notifyAuthChange(null);
  }

  async updateProfile(updates: Partial<AuthUser>): Promise<AuthResult> {
    if (!this.currentUser) {
      return { success: false, error: '未登录' };
    }

    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('profiles')
      .update({
        nickname: updates.nickname,
        avatar_url: updates.avatarUrl,
      })
      .eq('id', this.currentUser.id);

    if (error) {
      return { success: false, error: error.message };
    }

    this.currentUser = { ...this.currentUser, ...updates };
    this.notifyAuthChange(this.currentUser);
    return { success: true, user: this.currentUser };
  }

  async generateQuickLoginToken(): Promise<string | null> {
    if (!this.currentUser) {
      return null;
    }

    if (!isSupabaseInitialized()) {
      return null;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const supabase = getSupabase();

    const { error } = await supabase
      .from('profiles')
      .update({ quick_login_token: token })
      .eq('id', this.currentUser.id);

    if (error) {
      logger.error('Failed to generate quick login token:', error);
      return null;
    }

    return token;
  }

  /**
   * 发送密码重置邮件
   */
  async resetPassword(email: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'code-agent://auth/reset-callback',
    });

    if (error) {
      logger.error('Failed to send password reset email:', error);
      return { success: false, error: error.message };
    }

    logger.info('Password reset email sent to:', email);
    return { success: true };
  }

  /**
   * 更新密码（用户点击重置链接后调用）
   */
  async updatePassword(newPassword: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      logger.error('Failed to update password:', error);
      return { success: false, error: error.message };
    }

    logger.info('Password updated successfully');
    return { success: true };
  }

  /**
   * 处理密码重置回调（从 deep link 调用）
   * Supabase 的重置链接会带有 access_token 和 refresh_token
   */
  async handlePasswordResetCallback(accessToken: string, refreshToken: string): Promise<AuthResult> {
    if (!isSupabaseInitialized()) {
      return { success: false, error: 'Supabase not initialized' };
    }

    const supabase = getSupabase();

    // 使用 tokens 设置 session
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      logger.error('Failed to set session from reset callback:', error);
      return { success: false, error: error.message };
    }

    if (data.user) {
      this.currentUser = await this.fetchUserProfile(data.user);
      this.sessionTrustState = 'verified';
      this.cacheUser(this.currentUser);
      logger.info('Session set from password reset callback');
      return { success: true, user: this.currentUser };
    }

    return { success: false, error: 'Failed to get user from session' };
  }

  private async fetchUserProfile(user: SupabaseUser): Promise<AuthUser> {
    logger.info(' fetchUserProfile started for:', user.id);
    if (!isSupabaseInitialized()) {
      logger.info(' Supabase not initialized, returning basic user');
      return {
        id: user.id,
        email: user.email || '',
      };
    }

    const supabase = getSupabase();

    // Add timeout to prevent hanging
    try {
      logger.info(' Fetching profile from database...');
      // withTimeout 自动清理 timer；Supabase Builder 是 thenable，用 Promise.resolve 转 Promise
      const { data: profileRaw } = await withTimeout(
        Promise.resolve(supabase.from('profiles').select('*').eq('id', user.id).single()),
        5000,
        'Profile fetch timeout',
      ) as { data: unknown };
      logger.info(' Profile fetched:', profileRaw ? 'found' : 'not found');

      const profile = profileRaw as ProfileRow | null;

      return {
        id: user.id,
        email: user.email || '',
        username: profile?.username || undefined,
        nickname: profile?.nickname || undefined,
        avatarUrl: profile?.avatar_url || undefined,
        isAdmin: profile?.is_admin || false,
      };
    } catch (error) {
      logger.warn(' Failed to fetch profile, using basic user:', error);
      const memCached = this.currentUser;
      if (memCached?.id === user.id) {
        logger.warn(' Preserving in-memory profile after fetch failure');
        return memCached;
      }
      const diskCached = this.loadCachedUser();
      if (diskCached?.id === user.id) {
        logger.warn(' Preserving disk-cached profile after fetch failure');
        return diskCached;
      }
      return {
        id: user.id,
        email: user.email || '',
      };
    }
  }
}

// Singleton
let authServiceInstance: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!authServiceInstance) {
    authServiceInstance = new AuthService();
  }
  return authServiceInstance;
}

export type { AuthService };
