import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../services/core/databaseService';

export interface ChannelSessionBindingKey {
  accountId: string;
  chatId: string;
  threadId: string;
  ingressAuth: string;
}

export interface ChannelSessionBindingStorage {
  get(key: ChannelSessionBindingKey): string | undefined;
  set(key: ChannelSessionBindingKey, sessionId: string): void;
  delete(key: ChannelSessionBindingKey): void;
}

interface ChannelSessionBindingRow {
  session_id: string;
}

export class ChannelSessionBindingStore implements ChannelSessionBindingStorage {
  constructor(
    private readonly databaseProvider: () => BetterSqlite3.Database | null = () => getDatabase().getDb(),
  ) {}

  get(key: ChannelSessionBindingKey): string | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT session_id
      FROM channel_session_bindings
      WHERE account_id = ? AND chat_id = ? AND thread_id = ? AND ingress_auth = ?
    `).get(key.accountId, key.chatId, key.threadId, key.ingressAuth) as ChannelSessionBindingRow | undefined;
    return row?.session_id;
  }

  set(key: ChannelSessionBindingKey, sessionId: string): void {
    const now = Date.now();
    this.requireDatabase().prepare(`
      INSERT INTO channel_session_bindings (
        account_id, chat_id, thread_id, ingress_auth, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, chat_id, thread_id, ingress_auth) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(
      key.accountId,
      key.chatId,
      key.threadId,
      key.ingressAuth,
      sessionId,
      now,
      now,
    );
  }

  delete(key: ChannelSessionBindingKey): void {
    this.requireDatabase().prepare(`
      DELETE FROM channel_session_bindings
      WHERE account_id = ? AND chat_id = ? AND thread_id = ? AND ingress_auth = ?
    `).run(key.accountId, key.chatId, key.threadId, key.ingressAuth);
  }

  private requireDatabase(): BetterSqlite3.Database {
    const database = this.databaseProvider();
    if (!database) {
      throw new Error('Channel session binding database is not initialized');
    }
    return database;
  }
}
