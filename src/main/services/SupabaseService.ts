// ============================================================================
// Supabase Service
// Singleton client for Supabase backend
// ============================================================================

import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';
import { getSecureStorage } from './SecureStorage';

// Database types for type-safe queries
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string | null;
          nickname: string | null;
          avatar_url: string | null;
          quick_login_token: string | null;
          last_sync_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          username?: string | null;
          nickname?: string | null;
          avatar_url?: string | null;
          quick_login_token?: string | null;
        };
        Update: {
          username?: string | null;
          nickname?: string | null;
          avatar_url?: string | null;
          quick_login_token?: string | null;
          last_sync_at?: string | null;
        };
      };
      devices: {
        Row: {
          id: string;
          user_id: string;
          device_id: string;
          device_name: string | null;
          platform: string | null;
          sync_cursor: number;
          last_active_at: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          device_id: string;
          device_name?: string | null;
          platform?: string | null;
        };
        Update: {
          device_name?: string | null;
          sync_cursor?: number;
          last_active_at?: string;
        };
      };
      sessions: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          generation_id: string;
          model_provider: string | null;
          model_name: string | null;
          working_directory: string | null;
          is_deleted: boolean;
          created_at: number;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          id: string;
          user_id: string;
          title: string;
          generation_id: string;
          model_provider?: string | null;
          model_name?: string | null;
          working_directory?: string | null;
          created_at: number;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          title?: string;
          generation_id?: string;
          model_provider?: string | null;
          model_name?: string | null;
          working_directory?: string | null;
          is_deleted?: boolean;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
      messages: {
        Row: {
          id: string;
          session_id: string;
          user_id: string;
          role: string;
          content: string;
          timestamp: number;
          tool_calls: unknown | null;
          tool_results: unknown | null;
          is_deleted: boolean;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          id: string;
          session_id: string;
          user_id: string;
          role: string;
          content: string;
          timestamp: number;
          tool_calls?: unknown | null;
          tool_results?: unknown | null;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          content?: string;
          tool_calls?: unknown | null;
          tool_results?: unknown | null;
          is_deleted?: boolean;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
      user_preferences: {
        Row: {
          id: string;
          user_id: string;
          key: string;
          value: unknown;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          user_id: string;
          key: string;
          value: unknown;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          value?: unknown;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
      project_knowledge: {
        Row: {
          id: string;
          user_id: string;
          project_path: string;
          key: string;
          value: unknown;
          source: string;
          confidence: number;
          is_deleted: boolean;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          id: string;
          user_id: string;
          project_path: string;
          key: string;
          value: unknown;
          source: string;
          confidence?: number;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          value?: unknown;
          source?: string;
          confidence?: number;
          is_deleted?: boolean;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
      todos: {
        Row: {
          id: string;
          user_id: string;
          session_id: string;
          content: string;
          status: string;
          active_form: string;
          is_deleted: boolean;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          id: string;
          user_id: string;
          session_id: string;
          content: string;
          status: string;
          active_form: string;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          content?: string;
          status?: string;
          active_form?: string;
          is_deleted?: boolean;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
      invite_codes: {
        Row: {
          id: string;
          code: string;
          max_uses: number;
          use_count: number;
          expires_at: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          code: string;
          max_uses?: number;
          expires_at?: string | null;
        };
        Update: {
          use_count?: number;
          is_active?: boolean;
        };
      };
      vector_documents: {
        Row: {
          id: string;
          user_id: string;
          content: string;
          embedding: number[] | null;
          source: string;
          project_path: string | null;
          file_path: string | null;
          session_id: string | null;
          is_deleted: boolean;
          created_at: number;
          updated_at: number;
          source_device_id: string | null;
        };
        Insert: {
          id: string;
          user_id: string;
          content: string;
          embedding?: number[] | null;
          source: string;
          project_path?: string | null;
          file_path?: string | null;
          session_id?: string | null;
          created_at: number;
          updated_at: number;
          source_device_id?: string | null;
        };
        Update: {
          content?: string;
          embedding?: number[] | null;
          source?: string;
          project_path?: string | null;
          file_path?: string | null;
          session_id?: string | null;
          is_deleted?: boolean;
          updated_at?: number;
          source_device_id?: string | null;
        };
      };
    };
    Views: Record<string, never>;
    Functions: {
      increment_invite_code_usage: {
        Args: { code_value: string };
        Returns: void;
      };
      match_vectors: {
        Args: {
          query_embedding: number[];
          match_user_id: string;
          match_project_path?: string | null;
          match_threshold?: number;
          match_count?: number;
        };
        Returns: {
          id: string;
          content: string;
          source: string;
          project_path: string | null;
          file_path: string | null;
          session_id: string | null;
          similarity: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

let supabaseInstance: SupabaseClient<Database> | null = null;
let supabaseConfig: { url: string; anonKey: string } | null = null;

export function initSupabase(url: string, anonKey: string): SupabaseClient<Database> {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  supabaseConfig = { url, anonKey };
  const secureStorage = getSecureStorage();

  supabaseInstance = createClient<Database>(url, anonKey, {
    auth: {
      storage: {
        getItem: (key) => secureStorage.getItem(key),
        setItem: (key, value) => secureStorage.setItem(key, value),
        removeItem: (key) => secureStorage.removeItem(key),
      },
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // We handle OAuth manually in Electron
    },
    global: {
      headers: {
        'X-Client-Info': 'code-agent-electron',
      },
    },
  });

  return supabaseInstance;
}

export function getSupabase(): SupabaseClient<Database> {
  if (!supabaseInstance) {
    throw new Error('Supabase not initialized. Call initSupabase first.');
  }
  return supabaseInstance;
}

export function isSupabaseInitialized(): boolean {
  return supabaseInstance !== null;
}

export function getSupabaseConfig(): { url: string; anonKey: string } | null {
  return supabaseConfig;
}

// Helper types
export type { User as SupabaseUser, Session as SupabaseSession };

// Table row types for easier access
export type ProfileRow = Database['public']['Tables']['profiles']['Row'];
export type DeviceRow = Database['public']['Tables']['devices']['Row'];
export type SessionRow = Database['public']['Tables']['sessions']['Row'];
export type MessageRow = Database['public']['Tables']['messages']['Row'];
export type UserPreferenceRow = Database['public']['Tables']['user_preferences']['Row'];
export type InviteCodeRow = Database['public']['Tables']['invite_codes']['Row'];
export type VectorDocumentRow = Database['public']['Tables']['vector_documents']['Row'];
export type VectorMatchResult = Database['public']['Functions']['match_vectors']['Returns'][number];
