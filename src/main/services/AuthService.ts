// ============================================================================
// Auth Service
// Handles user authentication with Supabase
// ============================================================================

import { shell } from 'electron';
import crypto from 'crypto';
import {
  getSupabase,
  isSupabaseInitialized,
  SupabaseUser,
  ProfileRow,
  InviteCodeRow,
} from './SupabaseService';
import { getSecureStorage } from './SecureStorage';
import type { AuthUser, AuthStatus } from '../../shared/types';

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

type AuthChangeCallback = (user: AuthUser | null) => void;

class AuthService {
  private currentUser: AuthUser | null = null;
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
    this.onAuthChangeCallbacks.forEach((callback) => {
      try {
        callback(user);
      } catch (err) {
        console.error('Auth change callback error:', err);
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized || !isSupabaseInitialized()) {
      return;
    }

    const supabase = getSupabase();

    // Listen for auth state changes
    supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('Auth state changed:', event);

      if (session?.user) {
        this.currentUser = await this.fetchUserProfile(session.user);
        this.notifyAuthChange(this.currentUser);
      } else {
        this.currentUser = null;
        this.notifyAuthChange(null);
      }
    });

    // Check for existing session
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) {
      this.currentUser = await this.fetchUserProfile(session.user);
    }

    this.initialized = true;
  }

  async getStatus(): Promise<AuthStatus> {
    return {
      isAuthenticated: this.currentUser !== null,
      user: this.currentUser,
      isLoading: false,
    };
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
      this.currentUser = await this.fetchUserProfile(data.user);
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

    // Validate invite code if provided
    if (inviteCode) {
      const { data: codeDataRaw, error: codeError } = await supabase
        .from('invite_codes')
        .select('*')
        .eq('code', inviteCode.toUpperCase())
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
      if (inviteCode) {
        await supabase.rpc('increment_invite_code_usage', {
          code_value: inviteCode.toUpperCase(),
        } as any);
      }

      // Create profile
      await supabase.from('profiles').insert({
        id: data.user.id,
        username: email.split('@')[0],
        quick_login_token: crypto.randomBytes(32).toString('hex'),
      } as any);

      this.currentUser = await this.fetchUserProfile(data.user);
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
        await supabase.from('profiles').insert({
          id: data.user.id,
          username: data.user.email?.split('@')[0] || data.user.id,
          nickname: data.user.user_metadata?.full_name,
          avatar_url: data.user.user_metadata?.avatar_url,
          quick_login_token: crypto.randomBytes(32).toString('hex'),
        } as any);
      }

      this.currentUser = await this.fetchUserProfile(data.user);
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
    if (!isSupabaseInitialized()) {
      return;
    }

    const supabase = getSupabase();
    await supabase.auth.signOut();
    const storage = getSecureStorage();
    await storage.clearSessionFromKeychain(); // Also clear from Keychain
    storage.clearAuthData();
    this.currentUser = null;
    this.notifyAuthChange(null);
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  // Clear current user without calling Supabase signOut (used when clearing cache)
  clearCurrentUser(): void {
    this.currentUser = null;
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
      // @ts-ignore Supabase types issue
      .update({
        nickname: updates.nickname,
        avatar_url: updates.avatarUrl,
        updated_at: new Date().toISOString(),
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
      // @ts-ignore Supabase types issue
      .update({ quick_login_token: token })
      .eq('id', this.currentUser.id);

    if (error) {
      console.error('Failed to generate quick login token:', error);
      return null;
    }

    return token;
  }

  private async fetchUserProfile(user: SupabaseUser): Promise<AuthUser> {
    if (!isSupabaseInitialized()) {
      return {
        id: user.id,
        email: user.email || '',
      };
    }

    const supabase = getSupabase();
    const { data: profileRaw } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    const profile = profileRaw as ProfileRow | null;

    return {
      id: user.id,
      email: user.email || '',
      username: profile?.username || undefined,
      nickname: profile?.nickname || undefined,
      avatarUrl: profile?.avatar_url || undefined,
    };
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
