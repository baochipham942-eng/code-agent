// ============================================================================
// Sync Service
// Handles data synchronization between local SQLite and Supabase
// ============================================================================

import {
  getSupabase,
  isSupabaseInitialized,
  type DeviceRow,
  type SessionRow,
  type MessageRow,
  type UserPreferenceRow,
  type VectorDocumentRow,
} from '../infra';
import { getDatabase } from '../core';
import { getAuthService } from '../auth';
import { getSecureStorage } from '../core';
import { getVectorStore, type VectorDocument } from '../../memory/vectorStore';
import type { SyncStatus, SyncConflict, DeviceInfo, GenerationId, ModelProvider, Message } from '../../../shared/types';
import type { StoredSession } from '../core';
import { createLogger } from '../infra/logger';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../../shared/constants';

const logger = createLogger('SyncService');

export interface SyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  conflicts: SyncConflict[];
  error?: string;
}

type SyncStatusCallback = (status: SyncStatus) => void;

class SyncService {
  private deviceId: string;
  private deviceName: string;
  private syncCursor: number = 0;
  private isSyncing: boolean = false;
  private isEnabled: boolean = false;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private pendingChanges: number = 0;
  private lastSyncAt: number | null = null;
  private lastError: string | undefined;
  private onStatusChangeCallbacks: SyncStatusCallback[] = [];
  private conflicts: SyncConflict[] = [];

  constructor() {
    const secureStorage = getSecureStorage();
    this.deviceId = secureStorage.getDeviceId();
    this.deviceName = secureStorage.getDeviceName();
  }

  addStatusChangeCallback(callback: SyncStatusCallback): () => void {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      const index = this.onStatusChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.onStatusChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStatusChange(): void {
    const status = this.getStatus();
    this.onStatusChangeCallbacks.forEach((callback) => {
      try {
        callback(status);
      } catch (err) {
        logger.error('Sync status callback error', err as Error);
      }
    });
  }

  getStatus(): SyncStatus {
    return {
      isEnabled: this.isEnabled,
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      pendingChanges: this.pendingChanges,
      error: this.lastError,
    };
  }

  async initialize(): Promise<void> {
    if (!isSupabaseInitialized()) {
      return;
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return;
    }

    // Register device and get sync cursor
    await this.registerDevice(user.id);
  }

  async registerDevice(userId: string): Promise<DeviceInfo | null> {
    if (!isSupabaseInitialized()) {
      return null;
    }

    const supabase = getSupabase();
    const platform = process.platform;

    // Upsert device
    // TODO: Supabase 类型系统限制，upsert 需要 as any
    const { data: dataRaw, error } = await supabase
      .from('devices')
      .upsert(
        {
          user_id: userId,
          device_id: this.deviceId,
          device_name: this.deviceName,
          platform,
          last_active_at: new Date().toISOString(),
        } as any,
        {
          onConflict: 'user_id,device_id',
        }
      )
      .select()
      .single();

    if (error) {
      logger.error('Failed to register device', { error });
      return null;
    }

    const data = dataRaw as DeviceRow;
    this.syncCursor = data.sync_cursor || 0;

    return {
      id: data.id,
      deviceId: data.device_id,
      deviceName: data.device_name || '',
      platform: data.platform || '',
      lastActiveAt: new Date(data.last_active_at).getTime(),
      isCurrent: true,
    };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!isSupabaseInitialized()) {
      return [];
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return [];
    }

    const supabase = getSupabase();
    const { data: dataRaw, error } = await supabase
      .from('devices')
      .select('*')
      .eq('user_id', user.id)
      .order('last_active_at', { ascending: false });

    if (error) {
      logger.error('Failed to list devices', { error });
      return [];
    }

    const data = (dataRaw || []) as DeviceRow[];
    return data.map((d) => ({
      id: d.id,
      deviceId: d.device_id,
      deviceName: d.device_name || '',
      platform: d.platform || '',
      lastActiveAt: new Date(d.last_active_at).getTime(),
      isCurrent: d.device_id === this.deviceId,
    }));
  }

  async removeDevice(deviceId: string): Promise<void> {
    if (!isSupabaseInitialized()) {
      return;
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return;
    }

    const supabase = getSupabase();
    await supabase
      .from('devices')
      .delete()
      .eq('user_id', user.id)
      .eq('device_id', deviceId);
  }

  async startAutoSync(intervalMs: number = 5 * 60 * 1000): Promise<void> {
    if (this.syncInterval || !isSupabaseInitialized()) {
      return;
    }

    this.isEnabled = true;
    this.notifyStatusChange();

    // Sync immediately
    await this.sync();

    // Set up interval
    this.syncInterval = setInterval(() => {
      this.sync().catch((err) => logger.error('Sync interval error', err));
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isEnabled = false;
    this.notifyStatusChange();
  }

  async sync(): Promise<SyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Sync already in progress',
      };
    }

    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Not authenticated',
      };
    }

    if (!isSupabaseInitialized()) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: 'Supabase not initialized',
      };
    }

    this.isSyncing = true;
    this.lastError = undefined;
    this.notifyStatusChange();

    try {
      // Pull from cloud
      const pullResult = await this.pullFromCloud(user.id);

      // Push to cloud
      const pushResult = await this.pushToCloud(user.id);

      // Update sync cursor
      await this.updateSyncCursor(user.id);

      this.lastSyncAt = Date.now();
      this.pendingChanges = 0;
      this.conflicts = pullResult.conflicts;

      return {
        success: true,
        pushed: pushResult.count,
        pulled: pullResult.count,
        conflicts: pullResult.conflicts,
      };
    } catch (error) {
      this.lastError = (error as Error).message;
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        error: this.lastError,
      };
    } finally {
      this.isSyncing = false;
      this.notifyStatusChange();
    }
  }

  async forceFullSync(): Promise<SyncResult> {
    this.syncCursor = 0;
    return this.sync();
  }

  private async pullFromCloud(
    userId: string
  ): Promise<{ count: number; conflicts: SyncConflict[] }> {
    const supabase = getSupabase();
    const db = getDatabase();
    const conflicts: SyncConflict[] = [];
    let count = 0;

    // Pull sessions
    const { data: remoteSessionsRaw } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .gt('updated_at', this.syncCursor)
      .order('updated_at', { ascending: true });

    const remoteSessions = (remoteSessionsRaw || []) as SessionRow[];

    for (const remote of remoteSessions) {
      try {
        const local = db.getSession(remote.id);

        if (!local) {
          // New record from cloud
          // 云端数据类型与本地类型不完全匹配，需要类型断言
          db.createSessionWithId(remote.id, {
            title: remote.title,
            generationId: remote.generation_id as GenerationId,
            modelConfig: {
              provider: (remote.model_provider as ModelProvider) || DEFAULT_PROVIDER,
              model: remote.model_name || DEFAULT_MODEL,
            },
            workingDirectory: remote.working_directory || undefined,
          });
          count++;
        } else if (remote.updated_at > local.updatedAt) {
          // Remote is newer
          if (remote.source_device_id !== this.deviceId) {
            // Check for conflict
            if (local.updatedAt > this.syncCursor) {
              // Local also modified - conflict
              conflicts.push({
                id: remote.id,
                table: 'sessions',
                localRecord: local,
                remoteRecord: remote,
                conflictType: 'update',
              });
            } else {
              // No conflict, update local
              db.updateSession(remote.id, {
                title: remote.title,
                generationId: remote.generation_id as GenerationId,
              });
              count++;
            }
          }
        }
      } catch (err) {
        logger.error('Error pulling session', { sessionId: remote.id, error: err });
      }
    }

    // Pull messages
    const { data: remoteMessagesRaw } = await supabase
      .from('messages')
      .select('*')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .gt('updated_at', this.syncCursor)
      .order('updated_at', { ascending: true })
      .limit(1000);

    const remoteMessages = (remoteMessagesRaw || []) as MessageRow[];

    for (const remote of remoteMessages) {
      try {
        // Check if session exists locally
        const session = db.getSession(remote.session_id);
        if (!session) continue;

        const localMessages = db.getMessages(remote.session_id);
        const localMsg = localMessages.find((m) => m.id === remote.id);

        if (!localMsg) {
          // New message from cloud
          // 云端消息类型需要断言为本地类型
          db.addMessage(remote.session_id, {
            id: remote.id,
            role: remote.role as Message['role'],
            content: remote.content,
            timestamp: remote.timestamp,
            toolCalls: remote.tool_calls as Message['toolCalls'],
            toolResults: remote.tool_results as Message['toolResults'],
          });
          count++;
        }
      } catch (err) {
        logger.error('Error pulling message', { messageId: remote.id, error: err });
      }
    }

    // Pull user preferences
    const { data: remotePrefsRaw } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', this.syncCursor);

    const remotePrefs = (remotePrefsRaw || []) as UserPreferenceRow[];

    for (const remote of remotePrefs) {
      try {
        db.setPreference(remote.key, remote.value);
        count++;
      } catch (err) {
        logger.error('Error pulling preference', { key: remote.key, error: err });
      }
    }

    // Pull vector documents
    const vectorCount = await this.pullVectorDocuments(userId);
    count += vectorCount;

    return { count, conflicts };
  }

  private async pushToCloud(userId: string): Promise<{ count: number }> {
    const supabase = getSupabase();
    const db = getDatabase();
    let count = 0;

    // Get all local sessions (not just modified ones)
    const sessions = db.listSessions(1000, 0);
    const pendingSessions = sessions.filter((s) => s.updatedAt > this.syncCursor);

    if (pendingSessions.length > 0) {
      const { error } = await supabase.from('sessions').upsert(
        pendingSessions.map((s) => ({
          id: s.id,
          user_id: userId,
          title: s.title,
          generation_id: s.generationId,
          model_provider: s.modelConfig.provider,
          model_name: s.modelConfig.model,
          working_directory: s.workingDirectory || null,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          source_device_id: this.deviceId,
          // TODO: Supabase upsert 类型限制
        })) as any,
        { onConflict: 'id' }
      );

      if (!error) {
        count += pendingSessions.length;
      } else {
        logger.error('Error pushing sessions', { error });
      }
    }

    // Push messages from ALL sessions (not just pending ones)
    // This ensures messages added after session was synced are still pushed
    for (const session of sessions) {
      const messages = db.getMessages(session.id);
      const pendingMessages = messages.filter((m) => m.timestamp > this.syncCursor);

      if (pendingMessages.length > 0) {
        const { error } = await supabase.from('messages').upsert(
          pendingMessages.map((m) => ({
            id: m.id,
            session_id: session.id,
            user_id: userId,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            tool_calls: m.toolCalls || null,
            tool_results: m.toolResults || null,
            updated_at: m.timestamp,
            source_device_id: this.deviceId,
            // TODO: Supabase upsert 类型限制
          })) as any,
          { onConflict: 'id' }
        );

        if (!error) {
          count += pendingMessages.length;
        } else {
          logger.error('Error pushing messages', { error });
        }
      }
    }

    // Push vector documents
    const vectorCount = await this.pushVectorDocuments(userId);
    count += vectorCount;

    return { count };
  }

  // --------------------------------------------------------------------------
  // Vector Document Sync
  // --------------------------------------------------------------------------

  private async pullVectorDocuments(userId: string): Promise<number> {
    const supabase = getSupabase();
    const vectorStore = getVectorStore();
    let count = 0;

    try {
      const { data: remoteDocsRaw, error } = await supabase
        .from('vector_documents')
        .select('*')
        .eq('user_id', userId)
        .eq('is_deleted', false)
        .gt('updated_at', this.syncCursor)
        .order('updated_at', { ascending: true })
        .limit(500);

      if (error) {
        logger.error('Error pulling vector documents', { error });
        return 0;
      }

      const remoteDocs = (remoteDocsRaw || []) as VectorDocumentRow[];

      for (const remote of remoteDocs) {
        try {
          // Check if document already exists locally
          const local = vectorStore.get(remote.id);

          if (!local && remote.embedding) {
            // New document from cloud - add directly with existing embedding
            // Note: We store embedding as number[] in JS, pgvector handles conversion
            const doc: VectorDocument = {
              id: remote.id,
              content: remote.content,
              embedding: remote.embedding,
              metadata: {
                source: remote.source as 'file' | 'conversation' | 'knowledge',
                projectPath: remote.project_path || undefined,
                filePath: remote.file_path || undefined,
                sessionId: remote.session_id || undefined,
                createdAt: remote.created_at,
              },
            };

            // Add to local store (bypass normal add which would regenerate embedding)
            // TODO: VectorStore 内部属性访问需要 as any，考虑添加公开方法
            (vectorStore as any).documents.set(remote.id, doc);
            (vectorStore as any).dirty = true;
            count++;
          }
        } catch (err) {
          logger.error('Error pulling vector document', { documentId: remote.id, error: err });
        }
      }

      // Save if we added any documents
      if (count > 0) {
        await vectorStore.save();
      }
    } catch (err) {
      logger.error('Error in pullVectorDocuments', err as Error);
    }

    return count;
  }

  private async pushVectorDocuments(userId: string): Promise<number> {
    const supabase = getSupabase();
    const vectorStore = getVectorStore();
    let count = 0;

    try {
      // Get all documents and filter by createdAt > syncCursor
      const stats = vectorStore.getStats();
      if (stats.documentCount === 0) return 0;

      // Access internal documents map
      // TODO: VectorStore 内部属性访问需要 as any，考虑添加公开方法
      const documents = (vectorStore as any).documents as Map<string, VectorDocument>;
      const pendingDocs: VectorDocument[] = [];

      for (const doc of documents.values()) {
        if (doc.metadata.createdAt > this.syncCursor) {
          pendingDocs.push(doc);
        }
      }

      if (pendingDocs.length === 0) return 0;

      // Batch upsert in chunks of 100
      const batchSize = 100;
      for (let i = 0; i < pendingDocs.length; i += batchSize) {
        const batch = pendingDocs.slice(i, i + batchSize);

        const { error } = await supabase.from('vector_documents').upsert(
          batch.map((doc) => ({
            id: doc.id,
            user_id: userId,
            content: doc.content,
            embedding: doc.embedding,
            source: doc.metadata.source,
            project_path: doc.metadata.projectPath || null,
            file_path: doc.metadata.filePath || null,
            session_id: doc.metadata.sessionId || null,
            created_at: doc.metadata.createdAt,
            updated_at: doc.metadata.createdAt,
            source_device_id: this.deviceId,
            // TODO: Supabase upsert 类型限制
          })) as any,
          { onConflict: 'id' }
        );

        if (!error) {
          count += batch.length;
        } else {
          logger.error('Error pushing vector documents', { error });
        }
      }
    } catch (err) {
      logger.error('Error in pushVectorDocuments', err as Error);
    }

    return count;
  }

  private async updateSyncCursor(userId: string): Promise<void> {
    const supabase = getSupabase();
    const newCursor = Date.now();

    await supabase
      .from('devices')
      // @ts-expect-error Supabase types issue
      .update({
        sync_cursor: newCursor,
        last_active_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('device_id', this.deviceId);

    this.syncCursor = newCursor;
  }

  async resolveConflict(
    conflictId: string,
    resolution: 'local' | 'remote' | 'merge'
  ): Promise<void> {
    const conflict = this.conflicts.find((c) => c.id === conflictId);
    if (!conflict) return;

    const db = getDatabase();
    const supabase = getSupabase();
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    if (!user) return;

    if (resolution === 'local') {
      // Push local version to cloud
      if (conflict.table === 'sessions') {
        // 冲突记录类型断言为本地会话类型
        const local = conflict.localRecord as StoredSession;
        // TODO: Supabase update 类型限制
        await (supabase.from('sessions') as any).update({
          title: local.title,
          generation_id: local.generationId,
          updated_at: Date.now(),
          source_device_id: this.deviceId,
        }).eq('id', conflict.id);
      }
    } else if (resolution === 'remote') {
      // Apply remote version locally
      if (conflict.table === 'sessions') {
        // 冲突记录类型断言为云端会话类型
        const remote = conflict.remoteRecord as SessionRow;
        db.updateSession(conflict.id, {
          title: remote.title,
          generationId: remote.generation_id as GenerationId,
        });
      }
    }

    // Remove from conflicts list
    this.conflicts = this.conflicts.filter((c) => c.id !== conflictId);
    this.notifyStatusChange();
  }

  incrementPendingChanges(): void {
    this.pendingChanges++;
    this.notifyStatusChange();
  }
}

// Singleton
let syncServiceInstance: SyncService | null = null;

export function getSyncService(): SyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new SyncService();
  }
  return syncServiceInstance;
}

export type { SyncService };
