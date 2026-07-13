import type { Message, Session } from '../../shared/contract';

export interface AgentSessionManagerLike {
  getMessages?(sessionId: string, limit?: number): Promise<Message[]>;
  updateSession?(sessionId: string, updates: Partial<Session>): Promise<void> | void;
  getSession?(sessionId: string, limit?: number): Promise<Session | null>;
  addMessageToSession?(sessionId: string, message: Message): Promise<void>;
  invalidateSessionCache?(sessionId: string): void;
}

interface SupabaseQueryResult<T = unknown> {
  data: T | null;
  error: unknown;
}

type SupabaseMutationQuery = PromiseLike<SupabaseQueryResult>;

interface SupabaseAgentTableQuery<T> extends PromiseLike<SupabaseQueryResult<T[]>> {
  select(columns?: string): SupabaseAgentTableQuery<T>;
  eq(column: string, value: unknown): SupabaseAgentTableQuery<T>;
  order(column: string, options: { ascending: boolean }): SupabaseAgentTableQuery<T>;
  insert(value: Record<string, unknown>): SupabaseMutationQuery;
  upsert(value: Record<string, unknown>, options?: { onConflict?: string }): SupabaseMutationQuery;
  update(value: Record<string, unknown>): SupabaseAgentTableQuery<T>;
}

interface SupabaseAgentClient {
  from(table: 'sessions'): SupabaseAgentTableQuery<Record<string, unknown>>;
  from(table: 'messages'): SupabaseAgentTableQuery<Record<string, unknown>>;
  from(table: string): SupabaseAgentTableQuery<Record<string, unknown>>;
}

export interface SupabaseAgentBinding {
  supabase: SupabaseAgentClient;
  userId: string;
}
